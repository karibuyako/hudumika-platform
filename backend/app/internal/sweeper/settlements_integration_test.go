//go:build integration

// Integration tests for the settlement and export sweeper jobs
// (RunDailySettlements, ExportQueuedJobs). They require a reachable
// database (DATABASE_URL); no Redis is needed — only the auto-dispatch
// job reads the online set. Only rows created by these tests are touched:
// every insert is tracked and deleted in cleanup; nothing is truncated.
package sweeper

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// settlementFixture owns the pool plus every row a settlement test
// inserted, so cleanup deletes exactly those rows and nothing else.
type settlementFixture struct {
	pool        *pgxpool.Pool
	users       []uuid.UUID
	merchants   []uuid.UUID
	orders      []uuid.UUID
	settlements []uuid.UUID
	exports     []uuid.UUID
}

func setupSettlements(t *testing.T) *settlementFixture {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL not set; skipping sweeper settlement integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	f := &settlementFixture{pool: pool}
	t.Cleanup(func() {
		for _, id := range f.exports {
			if _, err := pool.Exec(ctx, `DELETE FROM data_exports WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup export %s: %v", id, err)
			}
		}
		for _, id := range f.settlements {
			if _, err := pool.Exec(ctx, `DELETE FROM daily_settlements WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup settlement %s: %v", id, err)
			}
		}
		for _, id := range f.orders {
			if _, err := pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup order %s: %v", id, err)
			}
		}
		for _, id := range f.merchants {
			if _, err := pool.Exec(ctx, `DELETE FROM merchants WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup merchant %s: %v", id, err)
			}
		}
		for _, id := range f.users {
			if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup user %s: %v", id, err)
			}
		}
		pool.Close()
	})
	return f
}

func (f *settlementFixture) newUser(t *testing.T) uuid.UUID {
	t.Helper()
	phone := fmt.Sprintf("+25590%09d%s", time.Now().UnixNano()%1_000_000_000, uuid.NewString()[:4])
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("create user: %v", err)
	}
	f.users = append(f.users, id)
	return id
}

func (f *settlementFixture) newMerchant(t *testing.T, owner uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name)
		 VALUES ($1, $2) RETURNING id`,
		owner, "sweeper-settlement-merchant-"+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatalf("create merchant: %v", err)
	}
	f.merchants = append(f.merchants, id)
	return id
}

// newOrderAt inserts an order with the given status and created_at.
func (f *settlementFixture) newOrderAt(t *testing.T, customerID, merchantID uuid.UUID, status string, totalTZS int64, createdAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, total_tzs, created_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		customerID, merchantID, status, totalTZS, createdAt).Scan(&id); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	f.orders = append(f.orders, id)
	return id
}

func (f *settlementFixture) newExport(t *testing.T, userID uuid.UUID, status string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO data_exports (user_id, scope, format, status)
		 VALUES ($1, 'orders', 'csv', $2) RETURNING id`,
		userID, status).Scan(&id); err != nil {
		t.Fatalf("insert export: %v", err)
	}
	f.exports = append(f.exports, id)
	return id
}

// settlementWindow mirrors RunDailySettlements' UTC day split.
func settlementWindow(now time.Time) (yesterday, today time.Time) {
	utc := now.UTC()
	today = time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
	return today.AddDate(0, 0, -1), today
}

func settlementRow(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, cycleDate time.Time) (total int64, count int, status string) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`SELECT total_tzs, count, status FROM daily_settlements
		 WHERE merchant_id = $1 AND cycle_date = $2`, merchantID, cycleDate).
		Scan(&total, &count, &status)
	if err != nil {
		t.Fatalf("read settlement for %s: %v", merchantID, err)
	}
	return total, count, status
}

func countSettlements(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, cycleDate time.Time) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM daily_settlements
		 WHERE merchant_id = $1 AND cycle_date = $2`, merchantID, cycleDate).Scan(&n); err != nil {
		t.Fatalf("count settlements for %s: %v", merchantID, err)
	}
	return n
}

// TestRunDailySettlementsCreatesDraftForYesterday: paid orders from the
// previous UTC day fold into one draft settlement per merchant with the
// summed totals; a second run creates nothing new.
func TestRunDailySettlementsCreatesDraftForYesterday(t *testing.T) {
	f := setupSettlements(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	yesterday, _ := settlementWindow(time.Now())
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t))
	f.newOrderAt(t, customer, merchant, "paid", 3000, yesterday.Add(10*time.Hour))
	f.newOrderAt(t, customer, merchant, "paid", 5000, yesterday.Add(15*time.Hour))

	n, err := s.RunDailySettlements(ctx)
	if err != nil {
		t.Fatalf("run settlements: %v", err)
	}
	if n != 1 {
		t.Fatalf("settlements created = %d, want 1", n)
	}
	total, count, status := settlementRow(t, f.pool, merchant, yesterday)
	if total != 8000 || count != 2 || status != "draft" {
		t.Errorf("settlement = total %d count %d status %q, want 8000 2 draft", total, count, status)
	}

	if n, err := s.RunDailySettlements(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
	if got := countSettlements(t, f.pool, merchant, yesterday); got != 1 {
		t.Errorf("settlement rows = %d after two runs, want 1", got)
	}
}

// TestRunDailySettlementsIgnoresNonPaidAndToday: cancelled orders from
// yesterday and paid orders from today are excluded.
func TestRunDailySettlementsIgnoresNonPaidAndToday(t *testing.T) {
	f := setupSettlements(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	yesterday, today := settlementWindow(time.Now())
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t))
	f.newOrderAt(t, customer, merchant, "cancelled", 7000, yesterday.Add(12*time.Hour))
	f.newOrderAt(t, customer, merchant, "paid", 9000, today.Add(1*time.Hour))

	n, err := s.RunDailySettlements(ctx)
	if err != nil {
		t.Fatalf("run settlements: %v", err)
	}
	if n != 0 {
		t.Fatalf("settlements created = %d, want 0", n)
	}
	if got := countSettlements(t, f.pool, merchant, yesterday); got != 0 {
		t.Errorf("settlement rows = %d, want 0", got)
	}
}

// TestExportQueuedJobsCompletesQueued: queued exports flip to completed
// with completed_at stamped and file_url left NULL (no artifact store);
// other statuses are untouched and a second run is a no-op.
func TestExportQueuedJobsCompletesQueued(t *testing.T) {
	f := setupSettlements(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	user := f.newUser(t)
	queued := f.newExport(t, user, "queued")
	failed := f.newExport(t, user, "failed")

	n, err := s.ExportQueuedJobs(ctx)
	if err != nil {
		t.Fatalf("run exports: %v", err)
	}
	if n != 1 {
		t.Fatalf("exports completed = %d, want 1", n)
	}

	var status string
	var fileURL *string
	var completedAt *time.Time
	if err := f.pool.QueryRow(ctx,
		`SELECT status, file_url, completed_at FROM data_exports WHERE id = $1`, queued).
		Scan(&status, &fileURL, &completedAt); err != nil {
		t.Fatalf("read export %s: %v", queued, err)
	}
	if status != "completed" {
		t.Errorf("export status = %q, want completed", status)
	}
	if completedAt == nil {
		t.Errorf("export completed_at not stamped")
	}
	if fileURL != nil {
		t.Errorf("export file_url = %v, want NULL (no artifact store yet)", *fileURL)
	}

	var failedStatus string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM data_exports WHERE id = $1`, failed).Scan(&failedStatus); err != nil {
		t.Fatalf("read failed export: %v", err)
	}
	if failedStatus != "failed" {
		t.Errorf("failed export status = %q, want failed (untouched)", failedStatus)
	}

	if n, err := s.ExportQueuedJobs(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
}

// TestRunAllRunsSweeperJobs: one sweep cycle applies the settlement and
// export jobs alongside the existing ones (auto-cancel needs a deadline
// and expires vouchers; both are no-ops for this fixture's orders). The
// auto-assign job sees no online riders (this test never goes online) and
// leaves the order unassigned.
func TestRunAllRunsSweeperJobs(t *testing.T) {
	f := setupSettlements(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	yesterday, _ := settlementWindow(time.Now())
	customer := f.newUser(t)
	merchant := f.newMerchant(t, f.newUser(t))
	order := f.newOrderAt(t, customer, merchant, "paid", 4000, yesterday.Add(12*time.Hour))
	queued := f.newExport(t, customer, "queued")

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("run once: %v", err)
	}

	total, count, status := settlementRow(t, f.pool, merchant, yesterday)
	if total != 4000 || count != 1 || status != "draft" {
		t.Errorf("settlement = total %d count %d status %q, want 4000 1 draft", total, count, status)
	}
	var exportStatus string
	if err := f.pool.QueryRow(ctx,
		`SELECT status FROM data_exports WHERE id = $1`, queued).Scan(&exportStatus); err != nil {
		t.Fatalf("read export: %v", err)
	}
	if exportStatus != "completed" {
		t.Errorf("export status = %q, want completed", exportStatus)
	}
	if got := orderRider(t, f.pool, order); got != nil {
		t.Errorf("order rider = %v, want NULL (no online riders)", got)
	}
}
