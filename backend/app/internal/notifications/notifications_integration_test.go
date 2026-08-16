//go:build integration

// Integration tests for the in-app notification feed and preference store.
// They require a reachable database (DATABASE_URL, see backend/app/Makefile
// test-integration) and the notifications + notification_preferences tables
// (run `go run ./cmd/migrate -up` first). No docker is involved.
package notifications

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// setupNotifications truncates the notification tables and creates a fresh
// user, returning its id. The outbox is truncated too so a full delivery
// cycle sees only its own jobs.
func setupNotifications(t *testing.T) (*pgxpool.Pool, uuid.UUID) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping notifications integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	for _, table := range []string{"notifications", "notification_preferences", "notification_outbox"} {
		if _, err := pool.Exec(ctx, `TRUNCATE `+table); err != nil {
			t.Fatalf("truncate %s: %v", table, err)
		}
	}

	var userID uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`,
		"+255"+strconv.Itoa(int(time.Now().UnixNano()%1000000000))).Scan(&userID); err != nil {
		t.Fatalf("create user: %v", err)
	}
	return pool, userID
}

// TestPrefsUpsertRoundtrip: an upsert is returned verbatim by Get, including
// an explicit false toggle.
func TestPrefsUpsertRoundtrip(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)

	push := []byte(`{"order.accepted":true,"payment.failed":false}`)
	sms := []byte(`{"otp.requested":true}`)
	email := []byte(`{}`)
	inApp := []byte(`{"order.created":true}`)
	if err := store.Upsert(ctx, userID, push, sms, email, inApp); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	got, err := store.Get(ctx, userID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("get returned nil after upsert")
	}
	if !got.Push["order.accepted"] {
		t.Error("push.order.accepted not true")
	}
	if got.Push["payment.failed"] {
		t.Error("push.payment.failed not false")
	}
	if !got.SMS["otp.requested"] {
		t.Error("sms.otp.requested not true")
	}
	if len(got.Email) != 0 {
		t.Errorf("email = %v, want empty", got.Email)
	}
	if !got.InApp["order.created"] {
		t.Error("in_app.order.created not true")
	}

	// Overwrite: the second upsert replaces the whole row.
	if err := store.Upsert(ctx, userID, []byte(`{"shift.reminder":true}`), []byte(`{}`), []byte(`{}`), []byte(`{}`)); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	got, err = store.Get(ctx, userID)
	if err != nil {
		t.Fatalf("get after overwrite: %v", err)
	}
	if !got.Push["shift.reminder"] {
		t.Error("push.shift.reminder not true after overwrite")
	}
	if _, ok := got.Push["order.accepted"]; ok {
		t.Error("push.order.accepted survived overwrite")
	}
}

// TestPrefsGetMissingReturnsNil: no row yields (nil, nil), never an error.
func TestPrefsGetMissingReturnsNil(t *testing.T) {
	pool, userID := setupNotifications(t)
	store := NewPrefStore(pool)

	got, err := store.Get(context.Background(), userID)
	if err != nil {
		t.Fatalf("get missing: %v", err)
	}
	if got != nil {
		t.Fatalf("get missing returned %+v, want nil", got)
	}
}

// TestListPaginationPagesTwentyPlusFive: 25 notifications come back as two
// pages (20 + 5) with no overlap and no gaps.
func TestListPaginationPagesTwentyPlusFive(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)

	const total = 25
	for i := 0; i < total; i++ {
		// Distinct created_at so the page split follows insertion order.
		createdAt := time.Now().Add(-time.Duration(total-i) * time.Second)
		if _, err := pool.Exec(ctx,
			`INSERT INTO notifications (user_id, type, title, body, created_at)
			 VALUES ($1, $2, $3, $4, $5)`,
			userID, "order_status", "Title "+strconv.Itoa(i), "Body "+strconv.Itoa(i), createdAt); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}

	first, next, err := store.List(ctx, userID, 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(first) != 20 {
		t.Fatalf("page 1 has %d items, want 20", len(first))
	}
	if next == "" {
		t.Fatal("page 1 cursor empty, want next page")
	}

	second, next2, err := store.List(ctx, userID, 20, next)
	if err != nil {
		t.Fatalf("list page 2: %v", err)
	}
	if len(second) != 5 {
		t.Fatalf("page 2 has %d items, want 5", len(second))
	}
	if next2 != "" {
		t.Fatalf("page 2 cursor = %q, want empty", next2)
	}

	seen := make(map[uuid.UUID]bool, total)
	for _, n := range append(first, second...) {
		if seen[n.ID] {
			t.Fatalf("notification %s returned on both pages", n.ID)
		}
		seen[n.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("union has %d unique ids, want %d", len(seen), total)
	}

	// Newest first.
	if first[0].Title != "Title 24" {
		t.Errorf("first item = %q, want %q", first[0].Title, "Title 24")
	}
	if second[len(second)-1].Title != "Title 0" {
		t.Errorf("last item = %q, want %q", second[len(second)-1].Title, "Title 0")
	}
}

// TestMarkReadAndMarkAllRead: marking one notification flips only its flag;
// marking all flips the rest.
func TestMarkReadAndMarkAllRead(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)

	ids := make([]uuid.UUID, 0, 3)
	for i := 0; i < 3; i++ {
		var id uuid.UUID
		if err := pool.QueryRow(ctx,
			`INSERT INTO notifications (user_id, type, title, body)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			userID, "test", "T"+strconv.Itoa(i), "B").Scan(&id); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
		ids = append(ids, id)
	}

	if err := store.MarkRead(ctx, ids[0], userID); err != nil {
		t.Fatalf("mark read: %v", err)
	}

	var read bool
	if err := pool.QueryRow(ctx, `SELECT read FROM notifications WHERE id = $1`, ids[0]).Scan(&read); err != nil {
		t.Fatalf("read flag 0: %v", err)
	}
	if !read {
		t.Error("notification 0 not read after MarkRead")
	}
	if err := pool.QueryRow(ctx, `SELECT read FROM notifications WHERE id = $1`, ids[1]).Scan(&read); err != nil {
		t.Fatalf("read flag 1: %v", err)
	}
	if read {
		t.Error("notification 1 read before MarkAllRead")
	}

	// A foreign user's notification must not be touchable.
	var other uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`,
		"+255999999999").Scan(&other); err != nil {
		t.Fatalf("create other user: %v", err)
	}
	var foreign uuid.UUID
	if err := pool.QueryRow(ctx,
		`INSERT INTO notifications (user_id, type, title, body)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		other, "test", "foreign", "B").Scan(&foreign); err != nil {
		t.Fatalf("insert foreign: %v", err)
	}
	if err := store.MarkRead(ctx, foreign, userID); err == nil {
		t.Fatal("MarkRead on foreign notification: want ErrNotificationNotFound")
	} else if err != ErrNotificationNotFound {
		t.Fatalf("MarkRead foreign error = %v, want ErrNotificationNotFound", err)
	}

	if err := store.MarkAllRead(ctx, userID); err != nil {
		t.Fatalf("mark all read: %v", err)
	}
	for _, id := range ids {
		if err := pool.QueryRow(ctx, `SELECT read FROM notifications WHERE id = $1`, id).Scan(&read); err != nil {
			t.Fatalf("read flag %s: %v", id, err)
		}
		if !read {
			t.Errorf("notification %s still unread after MarkAllRead", id)
		}
	}
	// Foreign user's row is untouched.
	if err := pool.QueryRow(ctx, `SELECT read FROM notifications WHERE id = $1`, foreign).Scan(&read); err != nil {
		t.Fatalf("foreign read flag: %v", err)
	}
	if read {
		t.Error("foreign notification marked read")
	}
}

// TestPushProviderSendReturnsNil: the stub push provider never fails a
// well-formed message.
func TestPushProviderSendReturnsNil(t *testing.T) {
	p := NewPushProvider(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := p.Send(context.Background(), Message{
		Channel: "push", Recipient: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
		Template: "order.status", Payload: []byte(`{}`),
	}); err != nil {
		t.Fatalf("push send: %v", err)
	}
}

// TestFullPushCycle: enqueue a push via the PgOutbox, claim it, send it
// through the PushProvider and mirror it with InAppWriter — the row must be
// visible via PrefStore.List afterwards.
func TestFullPushCycle(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)
	outbox := NewPgOutbox(pool)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	payload, err := json.Marshal(map[string]any{
		"userId":   userID,
		"type":     "order.status",
		"title":    "Order on its way",
		"body":     "Your order is being delivered",
		"deepLink": "/orders/123",
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	msg := Message{
		Channel: "push", Recipient: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
		Template: "order.status", Payload: payload,
	}
	if err := outbox.Enqueue(ctx, msg); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	jobs, err := outbox.ClaimDue(ctx, "integration-notif-worker", 10)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	if len(jobs) != 1 {
		t.Fatalf("claimed %d jobs, want 1", len(jobs))
	}

	push := NewPushProvider(logger)
	if err := push.Send(ctx, jobs[0].Message); err != nil {
		t.Fatalf("push send: %v", err)
	}
	if err := outbox.Complete(ctx, jobs[0].ID); err != nil {
		t.Fatalf("complete: %v", err)
	}
	writer := NewInAppWriter(store, logger)
	if err := writer.OnSent(ctx, jobs[0].Message); err != nil {
		t.Fatalf("on sent: %v", err)
	}

	items, next, err := store.List(ctx, userID, 20, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("feed has %d items, want 1", len(items))
	}
	if next != "" {
		t.Fatalf("cursor = %q, want empty", next)
	}
	n := items[0]
	if n.Type != "order.status" || n.Title != "Order on its way" || n.Body != "Your order is being delivered" {
		t.Errorf("mirrored row = %+v, want order.status push", n)
	}
	if n.DeepLink == nil || *n.DeepLink != "/orders/123" {
		t.Errorf("deep link = %v, want /orders/123", n.DeepLink)
	}
	if n.Read {
		t.Error("new notification starts read")
	}

	// The outbox job itself is delivered.
	var status string
	if err := pool.QueryRow(ctx, `SELECT status FROM notification_outbox WHERE id = $1`, jobs[0].ID).Scan(&status); err != nil {
		t.Fatalf("read outbox status: %v", err)
	}
	if status != "sent" {
		t.Errorf("outbox status = %q, want sent", status)
	}
}

// TestInAppWriterSkipsNonPush: SMS messages must never create feed rows.
func TestInAppWriterSkipsNonPush(t *testing.T) {
	pool, userID := setupNotifications(t)
	ctx := context.Background()
	store := NewPrefStore(pool)
	writer := NewInAppWriter(store, slog.New(slog.NewTextHandler(io.Discard, nil)))

	if err := writer.OnSent(ctx, Message{
		Channel: "sms", Recipient: "+255700000001", Template: "otp", Payload: []byte(`{}`),
	}); err != nil {
		t.Fatalf("on sent (sms): %v", err)
	}
	items, _, err := store.List(ctx, userID, 20, "")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("feed has %d items, want 0 for sms", len(items))
	}
}
