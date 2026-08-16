//go:build integration

package audit

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// TestPgAuditIntegration requires a running Postgres with the migrations
// applied. Run `go run ./cmd/migrate -up` from the app directory first.
//
//	go test -tags integration ./internal/audit/
func TestPgAuditIntegration(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, "TRUNCATE audit_logs"); err != nil {
		t.Fatalf("truncate audit_logs (run `go run ./cmd/migrate -up` first): %v", err)
	}

	p := NewPg(pool)
	e := Entry{
		ActorID:    "00000000-0000-4000-8000-000000000001",
		ActorRole:  "admin",
		Action:     "refund.created",
		EntityType: "payments",
		EntityID:   "pay_123",
		Details:    json.RawMessage(`{"amountTZS":1000}`),
		RequestID:  "req-1",
		IP:         "203.0.113.7",
		CreatedAt:  time.Now(),
	}
	if err := p.Insert(ctx, e); err != nil {
		t.Fatalf("insert: %v", err)
	}

	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM audit_logs").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("rows = %d, want 1", count)
	}
}
