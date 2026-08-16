//go:build integration

// End-to-end payouts/ledger tests against real PostgreSQL. Run via
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/payouts/ -count=1
//
// Only ledger_entries, payout_batches and payout_entries are truncated: the
// wallet bounded context (sibling agent) owns different tables and must not
// have them cleared by this suite. The users row each test inserts is
// deleted in cleanup.
package payouts_test

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/payouts"
)

// setup connects to PostgreSQL and truncates only the payouts tables.
func setup(t *testing.T) *pgxpool.Pool {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(ctx, `TRUNCATE ledger_entries, payout_batches, payout_entries CASCADE`); err != nil {
		t.Fatalf("truncate payouts tables: %v", err)
	}
	return pool
}

// newUser inserts a users row (the ledger has no FK, but owners are user
// ids) and removes it at cleanup.
func newUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	userID := uuid.New()
	phone := fmt.Sprintf("+2558%09d", time.Now().UnixNano()%1_000_000_000)
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID) })
	return userID
}

// balance reads the running balance of the owner's last entry (0 when the
// owner has no entries).
func balance(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID) int64 {
	t.Helper()
	var b int64
	err := pool.QueryRow(context.Background(),
		`SELECT balance_tzs FROM ledger_entries WHERE account_owner_id = $1
		 ORDER BY created_at DESC, id DESC LIMIT 1`, ownerID).Scan(&b)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0
		}
		t.Fatalf("read balance: %v", err)
	}
	return b
}

func entryCount(t *testing.T, pool *pgxpool.Pool, ownerID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM ledger_entries WHERE account_owner_id = $1`, ownerID).Scan(&n); err != nil {
		t.Fatalf("count entries: %v", err)
	}
	return n
}

func append(t *testing.T, st *payouts.Store, ownerID uuid.UUID, entryType string, amount int64, key string) bool {
	t.Helper()
	applied, err := st.AppendEntry(context.Background(), payouts.LedgerEntryInput{
		AccountOwnerID: ownerID,
		AccountType:    "merchant",
		Type:           entryType,
		AmountTZS:      amount,
		IdempotencyKey: key,
	})
	if err != nil {
		t.Fatalf("append %s %d: %v", entryType, amount, err)
	}
	return applied
}

// TestAppendEntryRunningBalance: consecutive entries carry the running
// balance; a payout debit brings it back to zero.
func TestAppendEntryRunningBalance(t *testing.T) {
	pool := setup(t)
	owner := newUser(t, pool)
	st := payouts.NewStore(pool)

	if !append(t, st, owner, "order_earning", 15000, "t1-a") {
		t.Fatal("first append must apply")
	}
	if got := balance(t, pool, owner); got != 15000 {
		t.Fatalf("balance after order_earning = %d, want 15000", got)
	}
	if !append(t, st, owner, "delivery_fee", 2000, "t1-b") {
		t.Fatal("second append must apply")
	}
	if got := balance(t, pool, owner); got != 17000 {
		t.Fatalf("balance after delivery_fee = %d, want 17000", got)
	}
	if !append(t, st, owner, "payout", -17000, "t1-c") {
		t.Fatal("payout append must apply")
	}
	if got := balance(t, pool, owner); got != 0 {
		t.Fatalf("balance after payout = %d, want 0", got)
	}
	if n := entryCount(t, pool, owner); n != 3 {
		t.Fatalf("entry count = %d, want 3", n)
	}
}

// TestAppendEntryIdempotency: replaying the same idempotency_key applies
// nothing and leaves the ledger untouched.
func TestAppendEntryIdempotency(t *testing.T) {
	pool := setup(t)
	owner := newUser(t, pool)
	st := payouts.NewStore(pool)

	if !append(t, st, owner, "order_earning", 15000, "t2-key") {
		t.Fatal("first append must apply")
	}
	if applied := append(t, st, owner, "order_earning", 15000, "t2-key"); applied {
		t.Fatal("replay with the same idempotency_key must not apply")
	}
	if got := balance(t, pool, owner); got != 15000 {
		t.Fatalf("balance after replay = %d, want 15000", got)
	}
	if n := entryCount(t, pool, owner); n != 1 {
		t.Fatalf("entry count after replay = %d, want 1", n)
	}
}

// TestStatementWindowMath: opening is the balance just before `from`, closing
// is the last entry in the window, and the window is half-open.
func TestStatementWindowMath(t *testing.T) {
	pool := setup(t)
	owner := newUser(t, pool)
	ctx := context.Background()

	day1a := time.Date(2026, 8, 1, 10, 0, 0, 0, time.UTC)
	day1b := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 8, 2, 9, 0, 0, 0, time.UTC)

	// Direct inserts with explicit created_at (the store stamps now()).
	for _, e := range []struct {
		at      time.Time
		typ     string
		amount  int64
		balance int64
	}{
		{day1a, "order_earning", 5000, 5000},
		{day1b, "delivery_fee", 2000, 7000},
		{day2, "payout", -7000, 0},
	} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO ledger_entries (account_owner_id, account_type, type, amount_tzs, balance_tzs, idempotency_key, created_at)
			 VALUES ($1, 'merchant', $2, $3, $4, $5, $6)`,
			owner, e.typ, e.amount, e.balance, uuid.NewString(), e.at); err != nil {
			t.Fatalf("insert ledger entry: %v", err)
		}
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM ledger_entries WHERE account_owner_id = $1`, owner) })

	st := payouts.NewStore(pool)

	opening, closing, entries, err := st.Statement(ctx, owner,
		time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("statement day2: %v", err)
	}
	if opening != 7000 || closing != 0 {
		t.Fatalf("day2 window opening/closing = %d/%d, want 7000/0", opening, closing)
	}
	if len(entries) != 1 || entries[0].Type != "payout" || entries[0].AmountTZS != -7000 {
		t.Fatalf("day2 entries = %+v, want one payout of -7000", entries)
	}

	opening, closing, entries, err = st.Statement(ctx, owner,
		time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 2, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("statement day1: %v", err)
	}
	if opening != 0 || closing != 7000 {
		t.Fatalf("day1 window opening/closing = %d/%d, want 0/7000", opening, closing)
	}
	if len(entries) != 2 || entries[0].Type != "order_earning" || entries[1].Type != "delivery_fee" {
		t.Fatalf("day1 entries = %+v, want order_earning then delivery_fee", entries)
	}
	if entries[1].BalanceTZS != 7000 {
		t.Fatalf("day1 closing entry balance = %d, want 7000", entries[1].BalanceTZS)
	}

	// Empty window: opening is the last balance before from, closing equals
	// opening.
	opening, closing, entries, err = st.Statement(ctx, owner,
		time.Date(2026, 8, 3, 0, 0, 0, 0, time.UTC), time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("statement empty window: %v", err)
	}
	if opening != 0 || closing != 0 || len(entries) != 0 {
		t.Fatalf("empty window opening/closing/len = %d/%d/%d, want 0/0/0", opening, closing, len(entries))
	}
}

// TestAppendEntryConcurrency: 10 concurrent appends for one owner all apply
// and the final balance is exactly the sum — the advisory lock serializes
// the running balance computation.
func TestAppendEntryConcurrency(t *testing.T) {
	pool := setup(t)
	owner := newUser(t, pool)
	st := payouts.NewStore(pool)

	const workers = 10
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			applied, err := st.AppendEntry(context.Background(), payouts.LedgerEntryInput{
				AccountOwnerID: owner,
				AccountType:    "merchant",
				Type:           "order_earning",
				AmountTZS:      1000,
				IdempotencyKey: fmt.Sprintf("t4-%d", i),
			})
			if err != nil {
				errs <- err
				return
			}
			if !applied {
				errs <- fmt.Errorf("append %d not applied", i)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent append: %v", err)
	}

	if got := balance(t, pool, owner); got != workers*1000 {
		t.Fatalf("balance = %d, want %d", got, workers*1000)
	}
	if n := entryCount(t, pool, owner); n != workers {
		t.Fatalf("entry count = %d, want %d", n, workers)
	}
}

// TestListPayoutsPagination: 25 payout entries page as 20 + 5 via the
// keyset cursor, newest first.
func TestListPayoutsPagination(t *testing.T) {
	pool := setup(t)
	owner := newUser(t, pool)
	ctx := context.Background()

	st := payouts.NewStore(pool)
	batchID, err := st.CreateBatch(ctx, time.Now().UTC().Format("2006-01-02"))
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM payout_entries WHERE batch_id = $1`, batchID)
		_, _ = pool.Exec(ctx, `DELETE FROM payout_batches WHERE id = $1`, batchID)
	})

	// Distinct created_at so the newest-first order is deterministic.
	for i := 0; i < 25; i++ {
		if _, err := pool.Exec(ctx,
			`INSERT INTO payout_entries (batch_id, owner_id, amount_tzs, method, created_at)
			 VALUES ($1, $2, $3, 'mpesa', now() - make_interval(mins => $4::int))`,
			batchID, owner, 1000*(i+1), 25-i); err != nil {
			t.Fatalf("insert payout entry %d: %v", i, err)
		}
	}

	first, next, err := st.ListPayouts(ctx, owner, 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(first) != 20 || next == "" {
		t.Fatalf("page 1 = %d rows (next %q), want 20 with a cursor", len(first), next)
	}
	if first[0].AmountTZS != 25000 {
		t.Fatalf("page 1 newest amount = %d, want 25000", first[0].AmountTZS)
	}

	second, next, err := st.ListPayouts(ctx, owner, 20, next)
	if err != nil {
		t.Fatalf("list page 2: %v", err)
	}
	if len(second) != 5 || next != "" {
		t.Fatalf("page 2 = %d rows (next %q), want 5 with no cursor", len(second), next)
	}
	if second[4].AmountTZS != 1000 {
		t.Fatalf("page 2 oldest amount = %d, want 1000", second[4].AmountTZS)
	}
}

// TestCreateAndAddToBatch: AddToBatch appends the payout entry and bumps the
// batch totals.
func TestCreateAndAddToBatch(t *testing.T) {
	pool := setup(t)
	owner := newUser(t, pool)
	ctx := context.Background()

	st := payouts.NewStore(pool)
	batchID, err := st.CreateBatch(ctx, time.Now().UTC().Format("2006-01-02"))
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM payout_entries WHERE batch_id = $1`, batchID)
		_, _ = pool.Exec(ctx, `DELETE FROM payout_batches WHERE id = $1`, batchID)
	})

	if err := st.AddToBatch(ctx, batchID, owner, 17000, "mpesa"); err != nil {
		t.Fatalf("add to batch: %v", err)
	}
	var total int64
	var count int
	if err := pool.QueryRow(ctx, `SELECT total_tzs, count FROM payout_batches WHERE id = $1`, batchID).Scan(&total, &count); err != nil {
		t.Fatalf("batch totals: %v", err)
	}
	if total != 17000 || count != 1 {
		t.Fatalf("batch total/count = %d/%d, want 17000/1", total, count)
	}
}
