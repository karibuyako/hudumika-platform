//go:build integration

package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// setupQueryIntegration truncates ONLY audit_logs, seeds a few users/roles
// rows, and inserts 30 audit entries via PgAudit with varied actors,
// actions, entity types and (via UPDATE) distinct created_at timestamps so
// keyset pagination is deterministic. Entries land at base+i minutes.
//
//	go test -tags integration ./internal/audit/ -count=1
func setupQueryIntegration(t *testing.T) (*pgxpool.Pool, time.Time) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(ctx, "TRUNCATE audit_logs"); err != nil {
		t.Fatalf("truncate audit_logs (run `go run ./cmd/migrate -up` first): %v", err)
	}

	// A few identities so role counts and actor filters have context.
	userIDs := []uuid.UUID{
		uuid.MustParse("00000000-0000-4000-8000-000000000011"),
		uuid.MustParse("00000000-0000-4000-8000-000000000012"),
		uuid.MustParse("00000000-0000-4000-8000-000000000013"),
	}
	for i, id := range userIDs {
		if _, err := pool.Exec(ctx,
			`INSERT INTO users (id, phone) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
			id, fmt.Sprintf("+2557%d0000001", i+1)); err != nil {
			t.Fatalf("insert user: %v", err)
		}
		if _, err := pool.Exec(ctx,
			`INSERT INTO roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			id, []string{"customer", "merchant", "rider"}[i]); err != nil {
			t.Fatalf("insert role: %v", err)
		}
	}

	actors := []string{
		"00000000-0000-4000-8000-000000000021",
		"00000000-0000-4000-8000-000000000022",
		"00000000-0000-4000-8000-000000000023",
	}
	actions := []string{
		"order.created", "order.paid", "order.cancelled",
		"refund.created", "merchant.updated", "review.moderated",
	}
	entityTypes := []string{"orders", "payments", "merchants"}
	p := NewPg(pool)
	for i := 0; i < 30; i++ {
		e := Entry{
			ActorID:    actors[i%len(actors)],
			ActorRole:  "admin",
			Action:     actions[i%len(actions)],
			EntityType: entityTypes[i%len(entityTypes)],
			EntityID:   fmt.Sprintf("ent-%d", i%26),
			Details:    json.RawMessage(fmt.Sprintf(`{"seq":%d}`, i%10)),
			RequestID:  "req-30",
			IP:         fmt.Sprintf("203.0.113.%d", 1+(i%250)),
			CreatedAt:  time.Now(),
		}
		if err := p.Insert(ctx, e); err != nil {
			t.Fatalf("insert entry %d: %v", i, err)
		}
	}

	// Distinct created_at per row makes the (created_at, id) keyset fully
	// deterministic: entry i sits at base+i minutes. timestamptz stores
	// microsecond precision, so truncate base or boundary rows compare
	// strictly before/after their window edges.
	base := time.Now().Add(-48 * time.Hour).UTC().Truncate(time.Microsecond)
	rows, err := pool.Query(ctx, `SELECT id FROM audit_logs ORDER BY created_at, id`)
	if err != nil {
		t.Fatalf("select audit ids: %v", err)
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatalf("scan audit id: %v", err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate audit ids: %v", err)
	}
	if len(ids) != 30 {
		t.Fatalf("seeded rows = %d, want 30", len(ids))
	}
	for i, id := range ids {
		at := base.Add(time.Duration(i) * time.Minute)
		if _, err := pool.Exec(ctx,
			`UPDATE audit_logs SET created_at = $1 WHERE id = $2`, at, id); err != nil {
			t.Fatalf("update created_at %d: %v", i, err)
		}
	}
	return pool, base
}

func TestAuditQueryOverviewIntegration(t *testing.T) {
	pool, _ := setupQueryIntegration(t)
	ctx := context.Background()

	ov, err := NewQuery(pool).Overview(ctx)
	if err != nil {
		t.Fatalf("overview: %v", err)
	}

	// Metrics without a backing pipeline are honest zeros, always filled.
	zeroMetrics := []struct {
		name string
		got  *int
	}{
		{"activeBookings", ov.ActiveBookings},
		{"pendingApprovals", ov.PendingApprovals},
		{"openTickets", ov.OpenTickets},
		{"pendingPayoutsTZS", ov.PendingPayoutsTZS},
		{"exceptions", ov.Exceptions},
	}
	for _, m := range zeroMetrics {
		if m.got == nil {
			t.Fatalf("metric %s is nil, want 0", m.name)
		}
		if *m.got != 0 {
			t.Fatalf("metric %s = %d, want 0", m.name, *m.got)
		}
	}

	// activeOrders depends on the orders table (another milestone): absent
	// table must read 0 without error, present table any count >= 0.
	if ov.ActiveOrders == nil {
		t.Fatal("activeOrders is nil")
	}
	var ordersExist bool
	if err := pool.QueryRow(ctx,
		`SELECT to_regclass('public.orders') IS NOT NULL`).Scan(&ordersExist); err != nil {
		t.Fatalf("orders guard: %v", err)
	}
	if !ordersExist && *ov.ActiveOrders != 0 {
		t.Fatalf("activeOrders = %d, want 0 with no orders table", *ov.ActiveOrders)
	}

	if ov.Queue == nil {
		t.Fatal("queue is nil, want []")
	}
	if len(ov.Queue) != 0 {
		t.Fatalf("queue has %d items, want 0", len(ov.Queue))
	}
}

func TestAuditQueryListEntityTypeIntegration(t *testing.T) {
	pool, _ := setupQueryIntegration(t)

	entries, next, err := NewQuery(pool).List(context.Background(), ListParams{EntityType: "payments"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 10 {
		t.Fatalf("entries = %d, want 10", len(entries))
	}
	for _, e := range entries {
		if e.EntityType != "payments" {
			t.Fatalf("entity_type = %q, want payments", e.EntityType)
		}
	}
	if next != "" {
		t.Fatalf("next cursor = %q, want empty (exact divisor)", next)
	}
}

func TestAuditQueryListActionPrefixIntegration(t *testing.T) {
	pool, _ := setupQueryIntegration(t)

	entries, _, err := NewQuery(pool).List(context.Background(), ListParams{ActionPrefix: "order."})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	// i in [0,30) with i%6 in {0,1,2} is 15 entries; the default limit (20)
	// returns all of them.
	if len(entries) != 15 {
		t.Fatalf("entries = %d, want 15 (order.* actions)", len(entries))
	}
	for _, e := range entries {
		if len(e.Action) < 6 || e.Action[:6] != "order." {
			t.Fatalf("action = %q does not start with order.", e.Action)
		}
	}
}

func TestAuditQueryListWindowIntegration(t *testing.T) {
	pool, base := setupQueryIntegration(t)

	from := base.Add(10 * time.Minute)
	to := base.Add(20 * time.Minute)
	entries, _, err := NewQuery(pool).List(context.Background(), ListParams{From: &from, To: &to})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 11 {
		t.Fatalf("entries = %d, want 11 (minutes 10..20 inclusive)", len(entries))
	}
	for _, e := range entries {
		if e.CreatedAt.Before(from) || e.CreatedAt.After(to) {
			t.Fatalf("created_at %v outside [%v, %v]", e.CreatedAt, from, to)
		}
	}
}

func TestAuditQueryListActorIntegration(t *testing.T) {
	pool, _ := setupQueryIntegration(t)

	actor := uuid.MustParse("00000000-0000-4000-8000-000000000021")
	entries, _, err := NewQuery(pool).List(context.Background(), ListParams{ActorID: &actor})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 10 {
		t.Fatalf("entries = %d, want 10 (one in three actors)", len(entries))
	}
	for _, e := range entries {
		if e.ActorID != actor.String() {
			t.Fatalf("actor_id = %s, want %s", e.ActorID, actor)
		}
	}
}

func TestAuditQueryListCursorIntegration(t *testing.T) {
	pool, _ := setupQueryIntegration(t)
	ctx := context.Background()
	q := NewQuery(pool)

	key := func(e Entry) string {
		return e.CreatedAt.UTC().Format(time.RFC3339Nano) + "|" + e.ActorID + "|" + e.Action +
			"|" + e.EntityType + "|" + e.EntityID
	}

	// Page 1: 20 entries + a next cursor.
	page1, next1, err := q.List(ctx, ListParams{Limit: 20})
	if err != nil {
		t.Fatalf("page1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page1 = %d entries, want 20", len(page1))
	}
	if next1 == "" {
		t.Fatal("page1 missing next cursor")
	}
	for i := 1; i < len(page1); i++ {
		if page1[i-1].CreatedAt.Before(page1[i].CreatedAt) {
			t.Fatal("page1 not newest-first")
		}
	}

	// Page 2: 5 entries via the cursor, no overlap with page 1.
	page2, next2, err := q.List(ctx, ListParams{Limit: 5, Cursor: next1})
	if err != nil {
		t.Fatalf("page2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page2 = %d entries, want 5", len(page2))
	}
	seen := make(map[string]bool, 25)
	for _, e := range page1 {
		seen[key(e)] = true
	}
	for _, e := range page2 {
		if seen[key(e)] {
			t.Fatalf("page2 overlaps page1 at %s", key(e))
		}
		seen[key(e)] = true
	}
	if next2 == "" {
		t.Fatal("page2 missing next cursor")
	}

	// Page 3: the remaining 5 entries, no cursor.
	page3, next3, err := q.List(ctx, ListParams{Limit: 5, Cursor: next2})
	if err != nil {
		t.Fatalf("page3: %v", err)
	}
	if len(page3) != 5 {
		t.Fatalf("page3 = %d entries, want 5", len(page3))
	}
	for _, e := range page3 {
		if seen[key(e)] {
			t.Fatalf("page3 overlaps earlier pages at %s", key(e))
		}
		seen[key(e)] = true
	}
	if next3 != "" {
		t.Fatalf("page3 next cursor = %q, want empty", next3)
	}

	// Default limit is 20 with no overlap: a fresh cursor-less read returns
	// exactly the page-1 rows.
	fresh, _, err := q.List(ctx, ListParams{})
	if err != nil {
		t.Fatalf("default-limit list: %v", err)
	}
	if len(fresh) != 20 {
		t.Fatalf("default limit = %d entries, want 20", len(fresh))
	}
}

func TestAuditQueryListEmptyIntegration(t *testing.T) {
	pool, _ := setupQueryIntegration(t)

	entries, next, err := NewQuery(pool).List(context.Background(), ListParams{EntityType: "does-not-exist"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if entries == nil {
		t.Fatal("entries is nil, want empty slice")
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %d, want 0", len(entries))
	}
	if next != "" {
		t.Fatalf("next cursor = %q, want empty", next)
	}
}
