package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newTestHub starts a hub with no Redis spine (process-local fan-out, dev
// mode) and returns it; the run context is cancelled at test cleanup.
func newTestHub(t *testing.T) *Hub {
	t.Helper()
	h := NewHub(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	go h.Run(ctx)
	t.Cleanup(cancel)
	return h
}

// dialTestClient dials an httptest server that upgrades through the hub for
// the given user with no session expiry. readSince backs sync frames; nil
// yields an error reply.
func dialTestClient(t *testing.T, h *Hub, userID string, readSince func(int64) ([]byte, error)) *websocket.Conn {
	t.Helper()
	return dialTestClientAt(t, h, userID, time.Time{}, readSince)
}

// dialTestClientAt is dialTestClient with an explicit session expiry: the
// server-side connection is closed with a policy frame once expiresAt passes.
func dialTestClientAt(t *testing.T, h *Hub, userID string, expiresAt time.Time, readSince func(int64) ([]byte, error)) *websocket.Conn {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.HandleConn(w, r, userID, expiresAt, readSince, func(*http.Request) bool { return true })
	}))
	t.Cleanup(srv.Close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// readMessage reads one text frame with a deadline, failing the test when
// nothing arrives in time.
func readMessage(t *testing.T, conn *websocket.Conn, timeout time.Duration) string {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(data)
}

// expectNoMessage asserts no frame arrives within the window.
func expectNoMessage(t *testing.T, conn *websocket.Conn, window time.Duration) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(window))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("unexpected frame received")
	}
}

// waitForClients blocks until the hub has registered n clients. A broadcast
// issued before the hub processed a client's register frame is dropped by
// design, so tests must wait for membership before asserting delivery.
func waitForClients(t *testing.T, h *Hub, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		count := len(h.clients)
		h.mu.Unlock()
		if count == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("hub clients = %d, want %d", count, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestHubBroadcastToUserIsUserScoped(t *testing.T) {
	h := newTestHub(t)
	alice := dialTestClient(t, h, "alice", nil)
	bob := dialTestClient(t, h, "bob", nil)
	waitForClients(t, h, 2)

	h.BroadcastToUser("alice", []byte(`{"n":1}`))

	if got := readMessage(t, alice, time.Second); got != `{"n":1}` {
		t.Fatalf("alice got %q, want the payload", got)
	}
	expectNoMessage(t, bob, 300*time.Millisecond)
}

func TestHubBroadcastToUnknownUserDeliversNothing(t *testing.T) {
	h := newTestHub(t)
	conn := dialTestClient(t, h, "carol", nil)
	waitForClients(t, h, 1)

	h.BroadcastToUser("nobody", []byte("x"))

	expectNoMessage(t, conn, 300*time.Millisecond)
}

func TestHubBroadcastAllReachesEveryClient(t *testing.T) {
	h := newTestHub(t)
	alice := dialTestClient(t, h, "alice", nil)
	bob := dialTestClient(t, h, "bob", nil)
	waitForClients(t, h, 2)

	h.BroadcastAll([]byte(`{"type":"announcement"}`))

	if got := readMessage(t, alice, time.Second); got != `{"type":"announcement"}` {
		t.Fatalf("alice got %q", got)
	}
	if got := readMessage(t, bob, time.Second); got != `{"type":"announcement"}` {
		t.Fatalf("bob got %q", got)
	}
}

func TestHubPingPong(t *testing.T) {
	h := newTestHub(t)
	conn := dialTestClient(t, h, "alice", nil)

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	if got := readMessage(t, conn, time.Second); got != `{"type":"pong"}` {
		t.Fatalf("got %q, want pong", got)
	}
}

func TestHubSyncFrame(t *testing.T) {
	h := newTestHub(t)
	readSince := func(after int64) ([]byte, error) {
		return []byte(`{"type":"sync","events":[],"latestSeq":` + strconv.FormatInt(after+1, 10) + `}`), nil
	}
	conn := dialTestClient(t, h, "alice", readSince)

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"sync","after":3}`)); err != nil {
		t.Fatalf("write sync: %v", err)
	}
	if got := readMessage(t, conn, time.Second); got != `{"type":"sync","events":[],"latestSeq":4}` {
		t.Fatalf("sync reply = %q", got)
	}
}

func TestHubSyncFrameDefaultsAfterToZero(t *testing.T) {
	h := newTestHub(t)
	readSince := func(after int64) ([]byte, error) {
		return []byte(`{"type":"sync","events":[],"latestSeq":` + strconv.FormatInt(after, 10) + `}`), nil
	}
	conn := dialTestClient(t, h, "alice", readSince)

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"sync"}`)); err != nil {
		t.Fatalf("write sync: %v", err)
	}
	if got := readMessage(t, conn, time.Second); got != `{"type":"sync","events":[],"latestSeq":0}` {
		t.Fatalf("sync reply = %q", got)
	}
}

func TestHubSyncBackendErrorRepliesSyncError(t *testing.T) {
	h := newTestHub(t)
	readSince := func(after int64) ([]byte, error) {
		return nil, errors.New("event log unavailable")
	}
	conn := dialTestClient(t, h, "alice", readSince)

	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"sync","after":0}`)); err != nil {
		t.Fatalf("write sync: %v", err)
	}
	got := readMessage(t, conn, time.Second)
	if !strings.Contains(got, "sync_error") {
		t.Fatalf("sync error reply = %q", got)
	}
}

func TestHubUnregisterStopsDelivery(t *testing.T) {
	h := newTestHub(t)
	alice := dialTestClient(t, h, "alice", nil)
	bob := dialTestClient(t, h, "bob", nil)
	waitForClients(t, h, 2)

	if err := alice.Close(); err != nil {
		t.Fatalf("close alice: %v", err)
	}
	// Unregister is asynchronous: wait until the hub holds exactly bob.
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		onlyBob := len(h.clients) == 1
		for c := range h.clients {
			if c.userID != "bob" {
				onlyBob = false
			}
		}
		h.mu.Unlock()
		if onlyBob {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("hub did not converge to exactly bob after alice closed")
		}
		time.Sleep(10 * time.Millisecond)
	}

	h.BroadcastAll([]byte("to-bob"))
	if got := readMessage(t, bob, time.Second); got != "to-bob" {
		t.Fatalf("bob got %q", got)
	}
}

// TestHubConnectionCapRefusesExcessPerUser registers a full quota of
// connections for one user and asserts the next dial is closed with a policy
// violation (1008) instead of being registered; once one connection closes,
// a new one is accepted again.
func TestHubConnectionCapRefusesExcessPerUser(t *testing.T) {
	h := newTestHub(t)
	var conns []*websocket.Conn
	for i := 0; i < h.MaxConnsPerUser; i++ {
		conns = append(conns, dialTestClient(t, h, "alice", nil))
	}
	waitForClients(t, h, h.MaxConnsPerUser)

	extra := dialTestClient(t, h, "alice", nil)
	_ = extra.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := extra.ReadMessage(); err == nil {
		t.Fatal("excess connection: expected a close frame, got data")
	} else {
		var closeErr *websocket.CloseError
		if !errors.As(err, &closeErr) {
			t.Fatalf("excess connection: error = %v, want a close error", err)
		}
		if closeErr.Code != websocket.ClosePolicyViolation {
			t.Fatalf("excess connection: close code = %d, want 1008", closeErr.Code)
		}
	}
	// The refused connection must never have been registered.
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	registered := len(h.clients)
	h.mu.Unlock()
	if registered != h.MaxConnsPerUser {
		t.Fatalf("hub clients = %d, want %d (refused dial was registered)", registered, h.MaxConnsPerUser)
	}

	// Closing one connection frees its slot.
	if err := conns[0].Close(); err != nil {
		t.Fatalf("close first connection: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		n := len(h.clients)
		h.mu.Unlock()
		if n == h.MaxConnsPerUser-1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("hub clients = %d, want %d after close", n, h.MaxConnsPerUser-1)
		}
		time.Sleep(10 * time.Millisecond)
	}

	replacement := dialTestClient(t, h, "alice", nil)
	waitForClients(t, h, h.MaxConnsPerUser)
	if err := replacement.Close(); err != nil {
		t.Fatalf("close replacement: %v", err)
	}
}

// TestHubACLFanOutNeverCrossesUsers asserts the per-user channel ACL: a
// broadcast for one user never reaches another user's connection, while a
// platform-wide push reaches everyone. Ordering matters: gorilla caches the
// error of a timed-out read, so a quiet-window check must be the LAST read
// on a connection — each connection here ends with either a successful read
// or its quiet check.
func TestHubACLFanOutNeverCrossesUsers(t *testing.T) {
	h := newTestHub(t)
	alice := dialTestClient(t, h, "alice", nil)
	bob := dialTestClient(t, h, "bob", nil)
	waitForClients(t, h, 2)

	// Platform topic reaches every user's connection.
	h.BroadcastAll([]byte(`{"n":0}`))
	if got := readMessage(t, alice, time.Second); got != `{"n":0}` {
		t.Fatalf("alice platform push got %q", got)
	}
	if got := readMessage(t, bob, time.Second); got != `{"n":0}` {
		t.Fatalf("bob platform push got %q", got)
	}

	h.BroadcastToUser("alice", []byte(`{"n":1}`))
	if got := readMessage(t, alice, time.Second); got != `{"n":1}` {
		t.Fatalf("alice got %q, want the alice payload", got)
	}
	h.BroadcastToUser("bob", []byte(`{"n":2}`))
	if got := readMessage(t, bob, time.Second); got != `{"n":2}` {
		t.Fatalf("bob got %q, want the bob payload", got)
	}
	h.BroadcastToUser("alice", []byte(`{"n":3}`))
	if got := readMessage(t, alice, time.Second); got != `{"n":3}` {
		t.Fatalf("alice got %q, want the alice payload", got)
	}

	// Final quiet windows: bob saw only his own {"n":2} and the platform
	// push, never alice's {"n":1}/{"n":3}; alice never saw bob's {"n":2}.
	expectNoMessage(t, bob, 300*time.Millisecond)
	expectNoMessage(t, alice, 300*time.Millisecond)
}

// TestHubExpiredSessionClosedWithPolicyViolation dials with an expiry already
// in the past and asserts the read loop closes the connection with 1008 on
// its first tick instead of serving it.
func TestHubExpiredSessionClosedWithPolicyViolation(t *testing.T) {
	h := newTestHub(t)
	conn := dialTestClientAt(t, h, "alice", time.Now().Add(-time.Minute), nil)

	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err := conn.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) {
		t.Fatalf("expired session: error = %v, want a close error", err)
	}
	if closeErr.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expired session: close code = %d, want 1008", closeErr.Code)
	}
}

// clientForUser returns the registered client for userID, failing the test
// when there is none.
func clientForUser(t *testing.T, h *Hub, userID string) *Client {
	t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if c.userID == userID {
			return c
		}
	}
	t.Fatalf("no registered client for user %q", userID)
	return nil
}

// waitForTopic blocks until the client's topic subscription state matches
// subscribed. Subscriptions are applied by the read loop asynchronously, so
// tests must wait before asserting delivery.
func waitForTopic(t *testing.T, h *Hub, c *Client, topic string, subscribed bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		_, ok := c.topics[topic]
		h.mu.Unlock()
		if ok == subscribed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("topic %q subscribed = %v, want %v", topic, ok, subscribed)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestHubTopicBroadcastReachesOnlySubscribers subscribes one of two clients
// to a conversation topic and asserts a topic broadcast reaches exactly that
// client: other topics do not leak in, and after an unsubscribe the topic
// goes silent. The final operation on each connection is its quiet check
// (gorilla caches the error of a timed-out read).
func TestHubTopicBroadcastReachesOnlySubscribers(t *testing.T) {
	h := newTestHub(t)
	alice := dialTestClient(t, h, "alice", nil)
	bob := dialTestClient(t, h, "bob", nil)
	waitForClients(t, h, 2)

	if err := alice.WriteMessage(websocket.TextMessage, []byte(`{"type":"subscribe","topic":"conversation:c1"}`)); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}
	aliceClient := clientForUser(t, h, "alice")
	waitForTopic(t, h, aliceClient, "conversation:c1", true)

	const payload = `{"type":"event","event":{"body":"hi"}}`
	h.BroadcastToTopic("conversation:c1", []byte(payload))
	if got := readMessage(t, alice, time.Second); got != payload {
		t.Fatalf("alice got %q, want the topic payload", got)
	}

	// A different topic must not reach alice, and bob (unsubscribed) must
	// not see the c1 payload.
	h.BroadcastToTopic("conversation:c2", []byte("other"))
	expectNoMessage(t, alice, 300*time.Millisecond)
	expectNoMessage(t, bob, 300*time.Millisecond)

	// Unsubscribe silences the topic for alice.
	if err := alice.WriteMessage(websocket.TextMessage, []byte(`{"type":"unsubscribe","topic":"conversation:c1"}`)); err != nil {
		t.Fatalf("write unsubscribe: %v", err)
	}
	waitForTopic(t, h, aliceClient, "conversation:c1", false)
	h.BroadcastToTopic("conversation:c1", []byte("again"))
	expectNoMessage(t, alice, 300*time.Millisecond)
}

// TestHubTopicAndUserRoutingStayIndependent asserts topic fan-out does not
// disturb the per-user ACL: a user-scoped push still reaches a topic
// subscriber, and a topic push reaches the subscriber without being filtered
// by the user ACL.
func TestHubTopicAndUserRoutingStayIndependent(t *testing.T) {
	h := newTestHub(t)
	alice := dialTestClient(t, h, "alice", nil)
	waitForClients(t, h, 1)

	if err := alice.WriteMessage(websocket.TextMessage, []byte(`{"type":"subscribe","topic":"conversation:c1"}`)); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}
	waitForTopic(t, h, clientForUser(t, h, "alice"), "conversation:c1", true)

	h.BroadcastToUser("alice", []byte(`{"n":1}`))
	if got := readMessage(t, alice, time.Second); got != `{"n":1}` {
		t.Fatalf("alice got %q, want the user push", got)
	}

	h.BroadcastToTopic("conversation:c1", []byte(`{"n":2}`))
	if got := readMessage(t, alice, time.Second); got != `{"n":2}` {
		t.Fatalf("alice got %q, want the topic push", got)
	}

	// A platform-wide push still reaches a topic subscriber.
	h.BroadcastAll([]byte(`{"n":4}`))
	if got := readMessage(t, alice, time.Second); got != `{"n":4}` {
		t.Fatalf("alice got %q, want the platform push", got)
	}

	// Final quiet window (must be the last read on the connection): a topic
	// alice did not subscribe to stays quiet.
	h.BroadcastToTopic("conversation:c9", []byte(`{"n":3}`))
	expectNoMessage(t, alice, 300*time.Millisecond)
}

// TestHubSubscribeUnknownTopicRejects asserts a subscribe frame for a topic
// outside the known namespaces is answered with the unknown-topic error and
// never registered.
func TestHubSubscribeUnknownTopicRejects(t *testing.T) {
	h := newTestHub(t)
	conn := dialTestClient(t, h, "alice", nil)
	waitForClients(t, h, 1)

	var ack struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	}
	if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"subscribe","topic":"gossip"}`)); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}
	if err := json.Unmarshal([]byte(readMessage(t, conn, time.Second)), &ack); err != nil {
		t.Fatalf("ack is not JSON: %v", err)
	}
	if ack.Type != "error" || ack.Message != "unknown topic" {
		t.Fatalf("got %+v, want the unknown-topic error", ack)
	}

	// The rejected topic must not be registered: a broadcast to it stays
	// silent.
	time.Sleep(50 * time.Millisecond)
	h.BroadcastToTopic("gossip", []byte("nope"))
	expectNoMessage(t, conn, 300*time.Millisecond)
}
