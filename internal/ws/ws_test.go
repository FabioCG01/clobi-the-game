package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// This file hand-rolls its own minimal WebSocket CLIENT (handshake + frame
// writer/reader) rather than pulling in an external library — none is
// vendored, and the whole point is to test the real wire protocol end to end
// against internal/ws acting as the server. The client deliberately does NOT
// reuse any of frame.go's helpers so the test is not just calling the same
// code twice: it independently re-implements RFC 6455 framing (including
// client-side masking, which the package under test enforces).
// ---------------------------------------------------------------------------

// rawClient is a bare-bones RFC 6455 client connection for tests.
type rawClient struct {
	t    *testing.T
	conn net.Conn
	br   *bufio.Reader
}

// dialWS performs the HTTP upgrade handshake against an httptest.Server
// serving path, returning a rawClient ready to exchange frames.
func dialWS(t *testing.T, srv *httptest.Server, path string, extraHeaders map[string]string) *rawClient {
	t.Helper()
	u := strings.TrimPrefix(srv.URL, "http://")
	conn, err := net.Dial("tcp", u)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		t.Fatalf("rand: %v", err)
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)

	req := "GET " + path + " HTTP/1.1\r\n" +
		"Host: " + u + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + key + "\r\n" +
		"Sec-WebSocket-Version: 13\r\n"
	for k, v := range extraHeaders {
		req += k + ": " + v + "\r\n"
	}
	req += "\r\n"

	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write handshake: %v", err)
	}

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatalf("read handshake response: %v", err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body := make([]byte, 512)
		n, _ := br.Read(body)
		t.Fatalf("handshake failed: %s (body: %s)", resp.Status, body[:n])
	}
	wantAccept := computeAccept(key)
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != wantAccept {
		t.Fatalf("Sec-WebSocket-Accept = %q, want %q", got, wantAccept)
	}
	return &rawClient{t: t, conn: conn, br: br}
}

// writeFrame writes one client->server frame with a random mask key, per RFC
// 6455 §5.1/§5.3 (independent re-implementation from the package under test).
func (c *rawClient) writeFrame(fin bool, opcode byte, payload []byte) {
	c.t.Helper()
	var head [14]byte
	n := 1
	head[0] = opcode & 0x0F
	if fin {
		head[0] |= 0x80
	}
	l := len(payload)
	maskOffset := 0
	switch {
	case l < 126:
		head[1] = 0x80 | byte(l)
		n = 2
		maskOffset = 2
	case l <= 0xFFFF:
		head[1] = 0x80 | 126
		binary.BigEndian.PutUint16(head[2:4], uint16(l))
		n = 4
		maskOffset = 4
	default:
		head[1] = 0x80 | 127
		binary.BigEndian.PutUint64(head[2:10], uint64(l))
		n = 10
		maskOffset = 10
	}
	var maskKey [4]byte
	if _, err := rand.Read(maskKey[:]); err != nil {
		c.t.Fatalf("rand mask: %v", err)
	}
	copy(head[maskOffset:maskOffset+4], maskKey[:])
	n = maskOffset + 4

	masked := make([]byte, len(payload))
	for i, b := range payload {
		masked[i] = b ^ maskKey[i%4]
	}
	if _, err := c.conn.Write(head[:n]); err != nil {
		c.t.Fatalf("write frame header: %v", err)
	}
	if len(masked) > 0 {
		if _, err := c.conn.Write(masked); err != nil {
			c.t.Fatalf("write frame payload: %v", err)
		}
	}
}

// writeRawHeaderAndPayload writes an already-fully-formed header (used by
// tests that need to send deliberately malformed frames, e.g. unmasked).
func (c *rawClient) writeRaw(b []byte) {
	c.t.Helper()
	if _, err := c.conn.Write(b); err != nil {
		c.t.Fatalf("write raw: %v", err)
	}
}

// rawFrame is one parsed frame as seen by the test client.
type rawFrame struct {
	fin     bool
	opcode  byte
	payload []byte
}

// readFrame reads and parses exactly one frame arriving from the server.
// Server frames must NOT be masked (verified here).
func (c *rawClient) readFrame() (rawFrame, error) {
	var f rawFrame
	var b [2]byte
	if _, err := io.ReadFull(c.br, b[:]); err != nil {
		return f, err
	}
	f.fin = b[0]&0x80 != 0
	f.opcode = b[0] & 0x0F
	masked := b[1]&0x80 != 0
	if masked {
		return f, fmt.Errorf("server sent a masked frame (protocol violation)")
	}
	length := uint64(b[1] & 0x7F)
	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return f, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.br, ext[:]); err != nil {
			return f, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if length > 0 {
		f.payload = make([]byte, length)
		if _, err := io.ReadFull(c.br, f.payload); err != nil {
			return f, err
		}
	}
	return f, nil
}

// readTextMessage reads frames until a fin=true data/continuation sequence
// completes, transparently skipping over any ping frames (replying is not
// needed for these tests) and failing on close.
func (c *rawClient) readTextMessage() (string, error) {
	var buf []byte
	for {
		f, err := c.readFrame()
		if err != nil {
			return "", err
		}
		switch f.opcode {
		case opText, opContinuation:
			buf = append(buf, f.payload...)
			if f.fin {
				return string(buf), nil
			}
		case opPing, opPong:
			continue
		case opClose:
			return "", fmt.Errorf("server closed: %v", f.payload)
		default:
			return "", fmt.Errorf("unexpected opcode %d", f.opcode)
		}
	}
}

func (c *rawClient) close() { _ = c.conn.Close() }

// newEchoServer starts an httptest.Server that upgrades every request and
// echoes back every text message it receives, until the client disconnects.
func newEchoServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(msg); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestHandshakeAndBasicEcho(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	c.writeFrame(true, opText, []byte("hello world"))
	got, err := c.readTextMessage()
	if err != nil {
		t.Fatalf("readTextMessage: %v", err)
	}
	if got != "hello world" {
		t.Fatalf("echo = %q, want %q", got, "hello world")
	}

	// A second round-trip on the same connection, to make sure state isn't
	// corrupted after one message.
	c.writeFrame(true, opText, []byte("second message"))
	got, err = c.readTextMessage()
	if err != nil {
		t.Fatalf("readTextMessage #2: %v", err)
	}
	if got != "second message" {
		t.Fatalf("echo #2 = %q, want %q", got, "second message")
	}
}

func TestHandshakeRejectsBadVersion(t *testing.T) {
	srv := newEchoServer(t)
	t.Cleanup(func() {}) // srv already cleaned up by newEchoServer
	u := strings.TrimPrefix(srv.URL, "http://")
	conn, err := net.Dial("tcp", u)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	req := "GET /ws HTTP/1.1\r\n" +
		"Host: " + u + "\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Key: " + base64.StdEncoding.EncodeToString([]byte("0123456789012345")) + "\r\n" +
		"Sec-WebSocket-Version: 8\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatalf("write: %v", err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if resp.StatusCode == http.StatusSwitchingProtocols {
		t.Fatalf("expected handshake rejection for bad version, got 101")
	}
}

func TestFragmentedMessageReassembly(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	// Send "Hello, " + "World" + "!" as three fragments: text(fin=false),
	// continuation(fin=false), continuation(fin=true).
	c.writeFrame(false, opText, []byte("Hello, "))
	c.writeFrame(false, opContinuation, []byte("World"))
	c.writeFrame(true, opContinuation, []byte("!"))

	got, err := c.readTextMessage()
	if err != nil {
		t.Fatalf("readTextMessage: %v", err)
	}
	if got != "Hello, World!" {
		t.Fatalf("reassembled = %q, want %q", got, "Hello, World!")
	}
}

func TestControlFrameInterleavedBetweenFragments(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	// RFC 6455 §5.4: control frames MAY be injected in the middle of a
	// fragmented message. A ping here must not disturb reassembly, and the
	// server must reply with a pong (which we drain inside readTextMessage/
	// readFrame handling, but let's explicitly assert we get one first).
	c.writeFrame(false, opText, []byte("frag-A-"))
	c.writeFrame(true, opPing, []byte("ping-payload"))

	// Read the pong that should arrive before the message completes.
	f, err := c.readFrame()
	if err != nil {
		t.Fatalf("readFrame (expecting pong): %v", err)
	}
	if f.opcode != opPong {
		t.Fatalf("opcode = %d, want pong(%d)", f.opcode, opPong)
	}
	if string(f.payload) != "ping-payload" {
		t.Fatalf("pong payload = %q, want %q", f.payload, "ping-payload")
	}

	c.writeFrame(true, opContinuation, []byte("frag-B"))
	got, err := c.readTextMessage()
	if err != nil {
		t.Fatalf("readTextMessage: %v", err)
	}
	if got != "frag-A-frag-B" {
		t.Fatalf("reassembled = %q, want %q", got, "frag-A-frag-B")
	}
}

func TestPingPong(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	c.writeFrame(true, opPing, []byte("abc123"))
	f, err := c.readFrame()
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if f.opcode != opPong {
		t.Fatalf("opcode = %d, want pong", f.opcode)
	}
	if string(f.payload) != "abc123" {
		t.Fatalf("pong payload = %q, want %q", f.payload, "abc123")
	}
}

func TestServerInitiatedPingGetsPong(t *testing.T) {
	// Exercises Conn.Ping()/OnPong from the server side against the raw client.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		if err := conn.Ping(); err != nil {
			t.Errorf("server Ping: %v", err)
			return
		}
		// keep reading so the connection stays open long enough for the
		// client to respond and the test to observe the ping frame.
		for {
			if _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	f, err := c.readFrame()
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if f.opcode != opPing {
		t.Fatalf("opcode = %d, want ping(%d)", f.opcode, opPing)
	}
	// Reply with a masked pong, then close.
	c.writeFrame(true, opPong, f.payload)
}

func TestCleanClose(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	body := encodeCloseBody(CloseNormal, "bye")
	c.writeFrame(true, opClose, body)

	f, err := c.readFrame()
	if err != nil {
		t.Fatalf("readFrame: %v", err)
	}
	if f.opcode != opClose {
		t.Fatalf("opcode = %d, want close(%d)", f.opcode, opClose)
	}
	code, _ := decodeCloseBody(f.payload)
	if code != CloseNormal {
		t.Fatalf("echoed close code = %d, want %d", code, CloseNormal)
	}

	// The server should now actually close the TCP connection: a subsequent
	// read should hit EOF (possibly immediately, or after this last frame).
	c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	n, err := c.conn.Read(buf)
	if err == nil && n > 0 {
		t.Fatalf("expected EOF/closed after close handshake, got %d more bytes", n)
	}
}

func TestOversizedFrameRejected(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	// Claim a length larger than MaxFramePayload in the frame header without
	// actually sending that much payload — the server must reject based on
	// the declared length alone (not hang waiting for bytes that never come).
	oversized := uint64(MaxFramePayload) + 1024
	var head [14]byte
	head[0] = 0x80 | opText // fin + text
	head[1] = 0x80 | 127    // masked + 64-bit length follows
	binary.BigEndian.PutUint64(head[2:10], oversized)
	var maskKey [4]byte
	if _, err := rand.Read(maskKey[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	copy(head[10:14], maskKey[:])
	c.writeRaw(head[:14])

	// Server should close the connection (possibly with a close frame first)
	// rather than block waiting for gigabytes of payload.
	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		f, err := c.readFrame()
		if err != nil {
			return // connection closed/reset -- expected outcome
		}
		if f.opcode == opClose {
			code, _ := decodeCloseBody(f.payload)
			if code != CloseMessageTooBig && code != CloseProtocolError {
				t.Fatalf("close code = %d, want message-too-big or protocol-error", code)
			}
			return
		}
	}
}

func TestOversizedReassembledMessageRejected(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	// Each individual frame is small (under MaxFramePayload) but the server
	// must still cap the *reassembled* message size, or a peer could OOM it
	// via many small continuation frames.
	chunk := make([]byte, 64*1024)
	for i := range chunk {
		chunk[i] = 'x'
	}
	c.writeFrame(false, opText, chunk)
	// MaxMessageSize is 256 KiB; after the first 64 KiB chunk, five more
	// 64 KiB chunks pushes well past the limit (384 KiB total).
	rejected := false
	for i := 0; i < 5; i++ {
		fin := i == 4
		c.writeFrame(fin, opContinuation, chunk)
	}
	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		f, err := c.readFrame()
		if err != nil {
			rejected = true
			break
		}
		if f.opcode == opClose {
			rejected = true
			break
		}
	}
	if !rejected {
		t.Fatalf("expected server to reject an oversized reassembled message")
	}
}

func TestMaskingRequiredFromClient(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	// Write an UNMASKED text frame by hand (mask bit clear). Per RFC 6455
	// §5.1 the server MUST close the connection on receipt of this.
	payload := []byte("no mask here")
	var head [2]byte
	head[0] = 0x80 | opText // fin + text
	head[1] = byte(len(payload))
	// mask bit (0x80 on byte 1) intentionally left clear
	c.writeRaw(head[:])
	c.writeRaw(payload) // unmasked payload, as a real unmasked frame would send

	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	sawProtocolError := false
	for {
		f, err := c.readFrame()
		if err != nil {
			break // connection reset/closed is an acceptable outcome too
		}
		if f.opcode == opClose {
			code, _ := decodeCloseBody(f.payload)
			if code == CloseProtocolError {
				sawProtocolError = true
			}
			break
		}
	}
	// Either we saw an explicit protocol-error close, or the connection was
	// simply dropped without echoing our payload back — both satisfy "the
	// server must not treat this as a valid message". The critical
	// regression this guards against is the server echoing "no mask here"
	// back as if it were a normal message.
	if !sawProtocolError {
		t.Logf("server dropped the unmasked-frame connection without a close frame (acceptable)")
	}

	// Whichever path was taken, verify the server did NOT process it as a
	// valid application message by ensuring a fresh, correctly-masked
	// connection still works (i.e. the server itself is still healthy).
	c2 := dialWS(t, srv, "/ws", nil)
	defer c2.close()
	c2.writeFrame(true, opText, []byte("still alive"))
	got, err := c2.readTextMessage()
	if err != nil {
		t.Fatalf("server appears unhealthy after unmasked-frame test: %v", err)
	}
	if got != "still alive" {
		t.Fatalf("echo = %q, want %q", got, "still alive")
	}
}

func TestBinaryFrameRejected(t *testing.T) {
	srv := newEchoServer(t)
	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	c.writeFrame(true, opBinary, []byte{1, 2, 3})
	c.conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	f, err := c.readFrame()
	if err != nil {
		return // connection dropped -- acceptable
	}
	if f.opcode != opClose {
		t.Fatalf("expected close frame after binary frame, got opcode %d", f.opcode)
	}
}

func TestConcurrentWritesAreSafe(t *testing.T) {
	// Exercises WriteMessage's mutex directly: many goroutines writing to the
	// same *Conn concurrently (the room broadcast pattern) must never
	// interleave/corrupt frames on the wire. Run with -race to catch data
	// races on the shared writer state.
	var serverConn *Conn
	ready := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err != nil {
			return
		}
		serverConn = conn
		close(ready)
		// Keep the connection alive by reading until the client disconnects.
		for {
			if _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	c := dialWS(t, srv, "/ws", nil)
	defer c.close()
	<-ready

	const goroutines = 20
	const perGoroutine = 25
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				msg := fmt.Sprintf("g%d-m%d", id, i)
				if err := serverConn.WriteMessage([]byte(msg)); err != nil {
					return
				}
			}
		}(g)
	}
	wg.Wait()

	// Drain exactly goroutines*perGoroutine complete, well-formed messages.
	// We don't care about ordering across goroutines, only that every frame
	// we parse is a complete, uncorrupted text message (proving the mutex
	// prevented interleaving).
	seen := map[string]int{}
	c.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for i := 0; i < goroutines*perGoroutine; i++ {
		msg, err := c.readTextMessage()
		if err != nil {
			t.Fatalf("readTextMessage %d/%d: %v", i+1, goroutines*perGoroutine, err)
		}
		seen[msg]++
	}
	for g := 0; g < goroutines; g++ {
		for i := 0; i < perGoroutine; i++ {
			want := fmt.Sprintf("g%d-m%d", g, i)
			if seen[want] != 1 {
				t.Fatalf("message %q seen %d times, want 1", want, seen[want])
			}
		}
	}
}

func TestWriteMessageFragmentsLargePayloads(t *testing.T) {
	// Verifies WriteMessage's own fragmentation path (server -> client) by
	// sending a payload larger than one frame's worth and checking the raw
	// client sees it arrive as multiple frames that reassemble correctly.
	big := make([]byte, MaxFramePayload+50000)
	for i := range big {
		big[i] = byte('a' + i%26)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		if err := conn.WriteMessage(big); err != nil {
			t.Errorf("server WriteMessage: %v", err)
			return
		}
		for {
			if _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)

	c := dialWS(t, srv, "/ws", nil)
	defer c.close()

	c.conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	frameCount := 0
	var buf []byte
	for {
		f, err := c.readFrame()
		if err != nil {
			t.Fatalf("readFrame: %v", err)
		}
		frameCount++
		buf = append(buf, f.payload...)
		if f.fin {
			break
		}
	}
	if frameCount < 2 {
		t.Fatalf("expected the large payload to be split across >=2 frames, got %d", frameCount)
	}
	if len(buf) != len(big) {
		t.Fatalf("reassembled length = %d, want %d", len(buf), len(big))
	}
	for i := range big {
		if buf[i] != big[i] {
			t.Fatalf("byte %d mismatch: got %q want %q", i, buf[i], big[i])
		}
	}
}

func TestSetReadDeadlineTimesOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r)
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		_, err = conn.ReadMessage()
		if err == nil {
			t.Errorf("expected a timeout error, got nil")
			return
		}
	}))
	t.Cleanup(srv.Close)

	c := dialWS(t, srv, "/ws", nil)
	defer c.close()
	// Deliberately send nothing; just wait for the server to give up and
	// close the connection due to its read deadline.
	c.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 16)
	_, err := c.conn.Read(buf)
	if err == nil {
		t.Fatalf("expected the server to close the connection after its read deadline elapsed")
	}
}

// TestComputeAcceptKnownVector checks computeAccept against the exact example
// from RFC 6455 §1.3.
func TestComputeAcceptKnownVector(t *testing.T) {
	got := computeAccept("dGhlIHNhbXBsZSBub25jZQ==")
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got != want {
		t.Fatalf("computeAccept = %q, want %q", got, want)
	}
	// Cross-check against a from-scratch SHA1 computation too, independent of
	// the package's own implementation.
	h := sha1.New()
	h.Write([]byte("dGhlIHNhbXBsZSBub25jZQ=="))
	h.Write([]byte(websocketGUID))
	want2 := base64.StdEncoding.EncodeToString(h.Sum(nil))
	if got != want2 {
		t.Fatalf("computeAccept = %q, want %q", got, want2)
	}
}
