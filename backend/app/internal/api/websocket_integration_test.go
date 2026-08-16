//go:build integration

// WebSocket /ws end-to-end against real Redis and real PostgreSQL: dial with
// a minted token, sync the event log, ping/pong, and receive the live push of
// a later PublishEvent within 2s (the events relay → ws:events pub/sub →
// hub fan-out). The sync frame reads the Redis events stream (mirroring
// /events), so the event published first is served by sync; the second
// publish exercises the live path.
// Run via: REDIS_URL=redis://localhost:6379/0 DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// go test -tags integration ./internal/api/ -run 'WebSocket' -count=1
// Setup DELetes the events stream so the test's sequence assertions are
// deterministic; event_log is left untouched (the sync path is Redis-backed
// here and other tests own that table).
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/hudumika/api-backend/internal/db"
)

// wsReadUntil reads frames until one of type wantType arrives (live pushes
// can legitimately interleave with sync replies), then decodes it into dst.
func wsReadUntil(t *testing.T, conn *websocket.Conn, wantType string, timeout time.Duration, dst any) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read frame (want %s): %v", wantType, err)
		}
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			t.Fatalf("frame is not JSON: %v (%s)", err, raw)
		}
		if probe.Type != wantType {
			continue
		}
		if err := json.Unmarshal(raw, dst); err != nil {
			t.Fatalf("decode %s frame: %v (%s)", wantType, err, raw)
		}
		return
	}
}

func TestWebSocketIntegration(t *testing.T) {
	s := newEventsRedisServer(t)
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	d, err := db.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(d.Close)
	s.SetDB(d)
	flushEventStreams(t, s)
	if err := s.stores.Redis.Client().Del(context.Background(), eventStreamKey).Err(); err != nil {
		t.Fatalf("flush events stream: %v", err)
	}

	token := tokenFor(t, s, "ws-integration-user", RoleCustomer, true)
	srv := httptest.NewServer(s.Router())
	t.Cleanup(srv.Close)

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?token="+token, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	ctx := context.Background()

	// An event published before the dial is served by the sync frame.
	if err := s.PublishEvent(ctx, "order.created", map[string]any{"orderId": "o-1"}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	time.Sleep(5 * time.Millisecond) // distinct stream-ID ms for a stable seq

	// Sync the event log. Live pushes may interleave, so read until the sync
	// reply arrives.
	if err := conn.WriteJSON(map[string]any{"type": "sync", "after": 0}); err != nil {
		t.Fatalf("write sync: %v", err)
	}
	var syncResp struct {
		Type   string `json:"type"`
		Events []struct {
			ID      int64          `json:"id"`
			Type    string         `json:"type"`
			At      string         `json:"at"`
			Payload map[string]any `json:"payload"`
		} `json:"events"`
		LatestSeq int64 `json:"latestSeq"`
	}
	wsReadUntil(t, conn, "sync", 2*time.Second, &syncResp)
	if len(syncResp.Events) != 1 {
		t.Fatalf("sync events = %d, want 1 (%+v)", len(syncResp.Events), syncResp.Events)
	}
	if len(syncResp.Events) != 1 {
		t.Fatalf("sync events = %d, want 1 (%+v)", len(syncResp.Events), syncResp.Events)
	}
	ev := syncResp.Events[0]
	if ev.Type != "order.created" || ev.Payload["orderId"] != "o-1" {
		t.Fatalf("sync event = %+v", ev)
	}
	if ev.ID <= 0 || ev.At == "" {
		t.Fatalf("sync event id/at = %d/%q", ev.ID, ev.At)
	}

	// Ping → pong. A stale live push for the first event may still be in
	// flight, so skip frames until the pong arrives.
	if err := conn.WriteJSON(map[string]any{"type": "ping"}); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	var pong struct {
		Type string `json:"type"`
	}
	wsReadUntil(t, conn, "pong", 2*time.Second, &pong)

	// A later publish must reach the open connection as a live push within 2s.
	if err := s.PublishEvent(ctx, "payment.captured", map[string]any{"amount": 100}); err != nil {
		t.Fatalf("publish live: %v", err)
	}
	// The push for the first event may still be in flight; skip events until
	// the payment.captured push (the target of this assertion) arrives.
	var push struct {
		Type  string `json:"type"`
		Event struct {
			ID      int64          `json:"id"`
			Type    string         `json:"type"`
			At      string         `json:"at"`
			Payload map[string]any `json:"payload"`
		} `json:"event"`
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if err := conn.ReadJSON(&push); err != nil {
			t.Fatalf("read live push: %v", err)
		}
		if push.Type == "event" && push.Event.Type == "payment.captured" {
			break
		}
	}
	if push.Event.Type != "payment.captured" || push.Event.Payload["amount"] != float64(100) {
		t.Fatalf("push event = %+v", push.Event)
	}
	if push.Event.ID <= 0 || push.Event.At == "" {
		t.Fatalf("push event id/at = %d/%q", push.Event.ID, push.Event.At)
	}
}

// TestWebSocketChatTopicLivePush exercises the real-time chat path end to
// end: a client opens /ws as one participant, subscribes to the
// conversation topic, and a chat message sent through the API by the other
// participant arrives as a live chat.message push within 2s. The topic
// routing is what is under test — the event's payload carries both the
// topic and the other participant's user id, and the relay must prefer the
// topic so the subscribed client receives it.
func TestWebSocketChatTopicLivePush(t *testing.T) {
	s := newEventsRedisServer(t)
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	d, err := db.New(context.Background(), os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	t.Cleanup(d.Close)
	s.SetDB(d)
	flushEventStreams(t, s)
	if err := s.stores.Redis.Client().Del(context.Background(), eventStreamKey).Err(); err != nil {
		t.Fatalf("flush events stream: %v", err)
	}

	ctx := context.Background()
	pool := d.Pool()
	// Seed this test's own conversation and users (chatPhonePrefix users
	// are owned by the chat suite, but the rows are cleaned by id here so
	// neither suite depends on the other's truncate).
	customerID, customerPhone := chatUser(t, pool)
	merchantID, merchantPhone := chatUser(t, pool)
	convID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO conversations (id, customer_user_id, merchant_id, subject) VALUES ($1, $2, $3, $4)`,
		convID, customerID, merchantID, "ws topic live push"); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM conversation_messages WHERE conversation_id = $1`, convID)
		_, _ = pool.Exec(ctx, `DELETE FROM conversations WHERE id = $1`, convID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1::uuid[])`, []uuid.UUID{customerID, merchantID})
	})

	customerToken := tokenFor(t, s, customerPhone, RoleCustomer, false)
	merchantToken := tokenFor(t, s, merchantPhone, RoleMerchant, false)
	srv := httptest.NewServer(s.Router())
	t.Cleanup(srv.Close)

	// The OTHER participant's client opens /ws and subscribes to the
	// conversation topic.
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws?token="+merchantToken, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	if err := conn.WriteJSON(map[string]any{"type": "subscribe", "topic": "conversation:" + convID.String()}); err != nil {
		t.Fatalf("write subscribe: %v", err)
	}

	// Send a message through the API; the subscribed client must receive
	// the chat.message push within 2s.
	rec := authedDo(t, s.Router(), http.MethodPost, "/conversations/"+convID.String()+"/messages",
		`{"body":"live hello"}`, customerToken)
	if rec.Code != http.StatusCreated {
		t.Fatalf("send = %d (%s)", rec.Code, rec.Body)
	}

	var push struct {
		Type  string `json:"type"`
		Event struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		} `json:"event"`
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if err := conn.ReadJSON(&push); err != nil {
			t.Fatalf("read live chat push: %v", err)
		}
		if push.Type == "event" && push.Event.Type == "chat.message" {
			break
		}
	}
	if push.Event.Payload["topic"] != "conversation:"+convID.String() {
		t.Fatalf("push topic = %v, want conversation:%s", push.Event.Payload["topic"], convID)
	}
	if push.Event.Payload["conversationId"] != convID.String() {
		t.Fatalf("push conversationId = %v, want %s", push.Event.Payload["conversationId"], convID)
	}
	if push.Event.Payload["user"] != merchantID.String() {
		t.Fatalf("push user = %v, want the other participant %s", push.Event.Payload["user"], merchantID)
	}
	msg, ok := push.Event.Payload["message"].(map[string]any)
	if !ok {
		t.Fatalf("push message = %v, want an object", push.Event.Payload["message"])
	}
	if msg["body"] != "live hello" || msg["authorUserId"] != customerID.String() || msg["authorRole"] != "customer" {
		t.Fatalf("push message = %+v, want body live hello by the customer", msg)
	}
}
