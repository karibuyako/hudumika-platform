//go:build integration

// Integration tests for the sweeper jobs. They require a reachable database
// (DATABASE_URL, see backend/app/Makefile test-integration) with the orders,
// order_events, vouchers, group_buy_deals and users tables (run `go run
// ./cmd/migrate -up` first). No docker is involved. Only rows created by
// these tests are touched: every insert is tracked and deleted in cleanup;
// nothing is truncated.
package sweeper

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// testFixture owns the pool plus every row a test inserted, so cleanup can
// delete exactly those rows and nothing else.
type testFixture struct {
	pool     *pgxpool.Pool
	users    []uuid.UUID
	deals    []uuid.UUID
	orders   []uuid.UUID
	vouchers []uuid.UUID
}

func setupSweeper(t *testing.T) *testFixture {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping sweeper integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	f := &testFixture{pool: pool}
	t.Cleanup(func() {
		for _, id := range f.vouchers {
			if _, err := pool.Exec(ctx, `DELETE FROM vouchers WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup voucher %s: %v", id, err)
			}
		}
		for _, id := range f.deals {
			if _, err := pool.Exec(ctx, `DELETE FROM group_buy_deals WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup deal %s: %v", id, err)
			}
		}
		for _, id := range f.orders {
			if _, err := pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup order %s: %v", id, err)
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

// newUser creates a user with a unique phone; used as customer and, for
// deals, as merchant (group_buy_deals.merchant_id references users).
func (f *testFixture) newUser(t *testing.T) uuid.UUID {
	t.Helper()
	phone := fmt.Sprintf("+255%09d%s", time.Now().UnixNano()%1_000_000_000, uuid.NewString()[:4])
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("create user: %v", err)
	}
	f.users = append(f.users, id)
	return id
}

// newDeal creates an active deal owned by the given merchant user.
func (f *testFixture) newDeal(t *testing.T, merchantID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO group_buy_deals (merchant_id, title, original_price_tzs, deal_price_tzs,
			quantity_total, start_at, end_at, status)
		 VALUES ($1, $2, 10000, 8000, 10, now(), now() + interval '1 day', 'active')
		 RETURNING id`,
		merchantID, "sweeper-test-deal-"+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatalf("create deal: %v", err)
	}
	f.deals = append(f.deals, id)
	return id
}

// insertOrder inserts an order with the given status and acceptance
// deadline.
func (f *testFixture) insertOrder(t *testing.T, customerID uuid.UUID, status string, deadline time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, deadline_at)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		customerID, uuid.New(), status, deadline).Scan(&id); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	f.orders = append(f.orders, id)
	return id
}

// insertVoucher inserts a voucher for the given deal and owner with the
// given status and expiry.
func (f *testFixture) insertVoucher(t *testing.T, dealID, userID uuid.UUID, status string, expiresAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO vouchers (deal_id, user_id, code, status, expires_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		dealID, userID, "GB-"+uuid.NewString()[:8], status, expiresAt).Scan(&id); err != nil {
		t.Fatalf("insert voucher: %v", err)
	}
	f.vouchers = append(f.vouchers, id)
	return id
}

func newTestSweeper(f *testFixture) *Sweeper {
	return New(f.pool, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Second)
}

func assertOrderStatus(t *testing.T, pool *pgxpool.Pool, id uuid.UUID, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM orders WHERE id = $1`, id).Scan(&got); err != nil {
		t.Fatalf("read order %s status: %v", id, err)
	}
	if got != want {
		t.Errorf("order %s status = %q, want %q", id, got, want)
	}
}

func assertVoucherStatus(t *testing.T, pool *pgxpool.Pool, id uuid.UUID, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM vouchers WHERE id = $1`, id).Scan(&got); err != nil {
		t.Fatalf("read voucher %s status: %v", id, err)
	}
	if got != want {
		t.Errorf("voucher %s status = %q, want %q", id, got, want)
	}
}

// TestAutoCancelStaleOrders: the sweep cancels draft and paid orders with a
// past deadline, skips fresh (future deadline) and completed ones, stamps
// cancelled_at and appends exactly one 'cancelled' event (by NULL, with the
// auto-cancel note) per cancelled order.
func TestAutoCancelStaleOrders(t *testing.T) {
	f := setupSweeper(t)
	ctx := context.Background()
	customer := f.newUser(t)
	s := newTestSweeper(f)

	stale := f.insertOrder(t, customer, "draft", time.Now().Add(-time.Hour))
	paid := f.insertOrder(t, customer, "paid", time.Now().Add(-time.Hour))
	fresh := f.insertOrder(t, customer, "draft", time.Now().Add(time.Hour))
	completed := f.insertOrder(t, customer, "completed", time.Now().Add(-time.Hour))

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("run once: %v", err)
	}

	assertOrderStatus(t, f.pool, stale, "cancelled")
	assertOrderStatus(t, f.pool, paid, "cancelled")
	assertOrderStatus(t, f.pool, fresh, "draft")
	assertOrderStatus(t, f.pool, completed, "completed")

	for _, id := range []uuid.UUID{stale, paid} {
		var (
			status, note string
			by           *uuid.UUID
			cancelledAt  *time.Time
		)
		if err := f.pool.QueryRow(ctx,
			`SELECT o.status, e.by, e.note, o.cancelled_at
			 FROM orders o JOIN order_events e ON e.order_id = o.id
			 WHERE o.id = $1 AND e.status = 'cancelled'`, id).
			Scan(&status, &by, &note, &cancelledAt); err != nil {
			t.Fatalf("read auto-cancel event for %s: %v", id, err)
		}
		if by != nil {
			t.Errorf("order %s auto-cancel event by = %v, want NULL", id, by)
		}
		if note != autoCancelNote {
			t.Errorf("order %s auto-cancel note = %q, want %q", id, note, autoCancelNote)
		}
		if cancelledAt == nil {
			t.Errorf("order %s cancelled_at not stamped", id)
		}
	}

	var events int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM order_events WHERE order_id = $1 AND status = 'cancelled'`, stale).Scan(&events); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if events != 1 {
		t.Errorf("stale order has %d cancelled events, want 1", events)
	}
}

// TestAutoCancelIdempotent: a second run cancels nothing new and appends no
// duplicate events.
func TestAutoCancelIdempotent(t *testing.T) {
	f := setupSweeper(t)
	ctx := context.Background()
	customer := f.newUser(t)
	s := newTestSweeper(f)

	stale := f.insertOrder(t, customer, "pending_payment", time.Now().Add(-time.Hour))

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("second run: %v", err)
	}

	assertOrderStatus(t, f.pool, stale, "cancelled")
	var events int
	if err := f.pool.QueryRow(ctx,
		`SELECT count(*) FROM order_events WHERE order_id = $1`, stale).Scan(&events); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if events != 1 {
		t.Errorf("stale order has %d events after two runs, want 1", events)
	}
}

// TestExpireVouchers: active vouchers past their expiry flip to 'expired';
// active vouchers in the future and already-used vouchers are untouched.
func TestExpireVouchers(t *testing.T) {
	f := setupSweeper(t)
	ctx := context.Background()
	user := f.newUser(t)
	deal := f.newDeal(t, user)
	s := newTestSweeper(f)

	expired := f.insertVoucher(t, deal, user, "active", time.Now().Add(-time.Hour))
	fresh := f.insertVoucher(t, deal, user, "active", time.Now().Add(time.Hour))
	used := f.insertVoucher(t, deal, user, "used", time.Now().Add(-time.Hour))

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("run once: %v", err)
	}

	assertVoucherStatus(t, f.pool, expired, "expired")
	assertVoucherStatus(t, f.pool, fresh, "active")
	assertVoucherStatus(t, f.pool, used, "used")

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("second run: %v", err)
	}
	assertVoucherStatus(t, f.pool, expired, "expired")
}

// TestRunAllRunsEveryJob: one sweep cycle applies the auto-cancel and the
// voucher expiry together, so a failing job could never starve the other.
func TestRunAllRunsEveryJob(t *testing.T) {
	f := setupSweeper(t)
	ctx := context.Background()
	customer := f.newUser(t)
	deal := f.newDeal(t, customer)
	s := newTestSweeper(f)

	order := f.insertOrder(t, customer, "draft", time.Now().Add(-time.Hour))
	voucher := f.insertVoucher(t, deal, customer, "active", time.Now().Add(-time.Hour))

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("run once: %v", err)
	}

	assertOrderStatus(t, f.pool, order, "cancelled")
	assertVoucherStatus(t, f.pool, voucher, "expired")
}
