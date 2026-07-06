package ws

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// Conn is one hijacked, upgraded WebSocket connection. The zero value is not
// usable; obtain one via Accept. A Conn is safe for concurrent use with one
// notable restriction, matching this package's intended usage (one reader
// goroutine per connection, broadcasts from many goroutines): ReadMessage
// must only ever be called from a single goroutine at a time (concurrent
// reads would race on frame reassembly), while WriteMessage, Close,
// CloseWithReason and SetReadDeadline may be called concurrently from any
// number of goroutines.
type Conn struct {
	nc net.Conn
	br *bufio.Reader
	bw *bufio.Writer

	writeMu sync.Mutex // serializes all frame writes (data + control) on bw

	readMu    sync.Mutex // serializes ReadMessage calls (reassembly state below is not itself concurrency-safe)
	closeOnce sync.Once
	closed    chan struct{} // closed exactly once, when the conn is torn down

	// onPong lets callers (tests, future keepalive code) observe pong control
	// frames; nil means "ignore". Pings always get an automatic pong reply
	// regardless of this hook.
	onPong func(payload []byte)
}

// newConn wraps a hijacked net.Conn + its buffered I/O pair into a *Conn.
func newConn(nc net.Conn, buf *bufio.ReadWriter) *Conn {
	return &Conn{
		nc:     nc,
		br:     buf.Reader,
		bw:     buf.Writer,
		closed: make(chan struct{}),
	}
}

// SetReadDeadline sets the deadline for future ReadMessage calls (and any
// control-frame handling done on their behalf, e.g. auto-replying to pings).
// A zero time.Time disables the deadline, matching net.Conn semantics. Use
// this for ping/pong keepalive: if no message (data or otherwise) arrives
// within the deadline, ReadMessage returns a timeout error.
func (c *Conn) SetReadDeadline(t time.Time) error {
	return c.nc.SetReadDeadline(t)
}

// SetWriteDeadline sets the deadline for future WriteMessage/Close calls.
func (c *Conn) SetWriteDeadline(t time.Time) error {
	return c.nc.SetWriteDeadline(t)
}

// RemoteAddr returns the peer's network address, mirroring net.Conn.
func (c *Conn) RemoteAddr() net.Addr { return c.nc.RemoteAddr() }

// ReadMessage blocks until one full text message has arrived (reassembling
// fragmented messages transparently) and returns its payload. Control frames
// (ping/pong/close) arriving between or before data frames are handled
// internally and never surfaced to the caller: pings are auto-replied with a
// pong of the same payload, pongs invoke the optional onPong hook, and a
// close frame terminates the read loop.
//
// Binary frames are rejected (this protocol is JSON-text-only per the
// multiplayer contract) with ErrProtocol, closing the connection — a
// conforming client of this server never sends one.
//
// On any error the connection has been closed (or is unusable) and the error
// is one of: ErrClosed (peer closed cleanly or connection torn down locally),
// a wrapped ErrProtocol/ErrNotMasked/ErrMessageTooBig, or a lower-level I/O
// error (timeout, reset, etc). Callers should treat any non-nil error as "the
// connection is done" and stop calling ReadMessage.
func (c *Conn) ReadMessage() ([]byte, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()

	var msg []byte
	var msgOpcode byte

	for {
		h, err := readFrameHeader(c.br)
		if err != nil {
			return nil, c.failRead(err)
		}
		if !h.masked {
			// RFC 6455 §5.1: "The server MUST close the connection upon
			// receiving a frame that is not masked."
			c.sendCloseAndTeardown(CloseProtocolError, "expected masked frame")
			return nil, ErrNotMasked
		}
		payload, err := readFramePayload(c.br, h)
		if err != nil {
			return nil, c.failRead(err)
		}

		switch h.opcode {
		case opContinuation:
			if msgOpcode == 0 {
				c.sendCloseAndTeardown(CloseProtocolError, "unexpected continuation frame")
				return nil, fmt.Errorf("%w: unexpected continuation frame", ErrProtocol)
			}
			if len(msg)+len(payload) > MaxMessageSize {
				c.sendCloseAndTeardown(CloseMessageTooBig, "message too big")
				return nil, ErrMessageTooBig
			}
			msg = append(msg, payload...)
			if h.fin {
				return c.finishTextMessage(msg, msgOpcode)
			}

		case opText, opBinary:
			if msgOpcode != 0 {
				c.sendCloseAndTeardown(CloseProtocolError, "expected continuation frame")
				return nil, fmt.Errorf("%w: new data frame mid-message", ErrProtocol)
			}
			if len(payload) > MaxMessageSize {
				c.sendCloseAndTeardown(CloseMessageTooBig, "message too big")
				return nil, ErrMessageTooBig
			}
			if h.fin {
				return c.finishTextMessage(payload, h.opcode)
			}
			msgOpcode = h.opcode
			msg = append(msg, payload...)

		case opPing:
			// Reply with a pong carrying the same payload (RFC 6455 §5.5.2/3).
			if err := c.writeControl(opPong, payload); err != nil {
				return nil, c.failRead(err)
			}

		case opPong:
			if c.onPong != nil {
				c.onPong(payload)
			}

		case opClose:
			code, reason := decodeCloseBody(payload)
			c.echoCloseAndTeardown(code, reason)
			return nil, ErrClosed

		default:
			c.sendCloseAndTeardown(CloseProtocolError, "unknown opcode")
			return nil, fmt.Errorf("%w: unknown opcode %d", ErrProtocol, h.opcode)
		}
	}
}

// finishTextMessage validates the completed message's opcode (binary is
// rejected) and returns it.
func (c *Conn) finishTextMessage(payload []byte, opcode byte) ([]byte, error) {
	if opcode != opText {
		c.sendCloseAndTeardown(CloseUnsupportedData, "binary frames not supported")
		return nil, fmt.Errorf("%w: binary frames not supported", ErrProtocol)
	}
	if payload == nil {
		payload = []byte{}
	}
	return payload, nil
}

// failRead classifies a lower-level read error: a clean or abrupt peer
// disconnect collapses to ErrClosed (with teardown), everything else
// (protocol/size errors already flagged upstream, timeouts, etc.) passes
// through after tearing the connection down.
func (c *Conn) failRead(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		c.teardown()
		return ErrClosed
	}
	if errors.Is(err, ErrMessageTooBig) {
		c.sendCloseAndTeardown(CloseMessageTooBig, "frame too big")
		return err
	}
	if errors.Is(err, ErrProtocol) {
		c.sendCloseAndTeardown(CloseProtocolError, "protocol error")
		return err
	}
	// Timeouts and other net.Conn errors: just tear down, no close frame
	// (the connection is likely already unusable for writing too).
	c.teardown()
	return err
}

// WriteMessage sends one text message, fragmenting internally into frames of
// at most MaxFramePayload bytes each if the payload is larger than that
// (correctness for completeness; in practice every message this server sends
// is far smaller than that limit). The overall message may be up to
// MaxOutgoingMessage, well beyond the stricter MaxMessageSize this package
// enforces on incoming reads — see MaxOutgoingMessage's doc comment for why
// outgoing traffic gets a more generous ceiling. Safe to call concurrently
// with itself and with other WriteMessage/Close calls — a single mutex
// serializes all outgoing frames so interleaved writers can never corrupt the
// stream.
func (c *Conn) WriteMessage(data []byte) error {
	if len(data) > MaxOutgoingMessage {
		return ErrMessageTooBig
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	if c.isClosed() {
		return ErrClosed
	}

	if len(data) <= MaxFramePayload {
		if err := writeFrame(c.bw, true, opText, data); err != nil {
			c.teardown()
			return err
		}
		return c.bw.Flush()
	}

	// Fragment across multiple frames: first opText, middle opContinuation,
	// last opContinuation with FIN=1.
	first := true
	for offset := 0; offset < len(data); offset += MaxFramePayload {
		end := offset + MaxFramePayload
		if end > len(data) {
			end = len(data)
		}
		chunk := data[offset:end]
		fin := end == len(data)
		op := byte(opContinuation)
		if first {
			op = opText
			first = false
		}
		if err := writeFrame(c.bw, fin, op, chunk); err != nil {
			c.teardown()
			return err
		}
	}
	return c.bw.Flush()
}

// writeControl sends one control frame (already under writeMu when called
// from ReadMessage's auto-pong path; acquires it itself otherwise).
func (c *Conn) writeControl(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.isClosed() {
		return ErrClosed
	}
	if err := writeControlFrame(c.bw, opcode, payload); err != nil {
		c.teardown()
		return err
	}
	return c.bw.Flush()
}

// Ping sends a ping control frame with an empty payload.
func (c *Conn) Ping() error {
	return c.writeControl(opPing, nil)
}

// OnPong registers a callback invoked (on the ReadMessage goroutine) whenever
// a pong control frame arrives. Intended for keepalive round-trip tracking.
// Not safe to call concurrently with ReadMessage; set it up before the read
// loop starts.
func (c *Conn) OnPong(fn func(payload []byte)) {
	c.onPong = fn
}

// Close closes the connection immediately with the normal closure code and no
// reason, sending a close frame if the connection is still writable.
func (c *Conn) Close() error {
	return c.CloseWithReason(CloseNormal, "")
}

// CloseWithReason sends a close frame carrying code and reason (best-effort —
// errors sending it are ignored, since the connection may already be broken)
// and tears down the underlying TCP connection. Safe to call multiple times
// and concurrently with everything else; only the first call has any effect.
func (c *Conn) CloseWithReason(code uint16, reason string) error {
	c.writeMu.Lock()
	if !c.isClosed() {
		_ = writeControlFrame(c.bw, opClose, encodeCloseBody(code, reason))
		_ = c.bw.Flush()
	}
	c.writeMu.Unlock()
	c.teardown()
	return nil
}

// sendCloseAndTeardown is used by ReadMessage when it detects a protocol
// violation: best-effort notify the peer, then tear down.
func (c *Conn) sendCloseAndTeardown(code uint16, reason string) {
	c.writeMu.Lock()
	if !c.isClosed() {
		_ = writeControlFrame(c.bw, opClose, encodeCloseBody(code, reason))
		_ = c.bw.Flush()
	}
	c.writeMu.Unlock()
	c.teardown()
}

// echoCloseAndTeardown handles a close frame received from the peer: RFC
// 6455 §5.5.1 requires echoing a close frame back (the same code is fine)
// before closing the TCP connection.
func (c *Conn) echoCloseAndTeardown(code uint16, _ string) {
	c.writeMu.Lock()
	if !c.isClosed() {
		_ = writeControlFrame(c.bw, opClose, encodeCloseBody(code, ""))
		_ = c.bw.Flush()
	}
	c.writeMu.Unlock()
	c.teardown()
}

// isClosed reports whether teardown has already run. Caller need not hold
// writeMu (closed is its own channel), but in practice every call site here
// already does, which is harmless.
func (c *Conn) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// teardown closes the underlying TCP connection exactly once and marks the
// Conn as closed for future WriteMessage/Close calls.
func (c *Conn) teardown() {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.nc.Close()
	})
}
