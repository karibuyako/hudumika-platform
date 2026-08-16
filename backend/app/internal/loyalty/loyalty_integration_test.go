//go:build integration

// End-to-end tests for the loyalty bounded context against real
// PostgreSQL. Run via `go test -tags integration ./internal/loyalty/
// -count=1` after `go run ./cmd/migrate -up`.
package loyalty

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestPool connects to DATABASE_URL and truncates only the loyalty
// bounded-context tables so tests are isolated from other agents' tables.
func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("integration: DATABASE_URL required")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE loyalty_members, membership_tiers, customer_memberships,
			loyalty_transactions, membership_top_up_rewards`); err != nil {
		t.Fatalf("truncate loyalty tables: %v", err)
	}
	return pool
}

// setupUser inserts a users row and returns its id.
func setupUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2556%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'Loyalty IT User') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

// createMember registers a member via the store and returns the row.
func createMember(t *testing.T, st *Store, merchant uuid.UUID, phone string) MemberRow {
	t.Helper()
	id, err := st.CreateMember(context.Background(), merchant, phone, "IT Member")
	if err != nil {
		t.Fatalf("create member: %v", err)
	}
	row, err := st.GetMember(context.Background(), id)
	if err != nil {
		t.Fatalf("get created member: %v", err)
	}
	return row
}

// TestMemberCreateAndDuplicatePhone covers create -> get (zero balance) and
// the (merchant_id, phone) uniqueness rule, including that the same phone
// may register with another merchant.
func TestMemberCreateAndDuplicatePhone(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	other := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	id, err := st.CreateMember(ctx, merchant, "+255700000001", "Amina")
	if err != nil {
		t.Fatalf("create member: %v", err)
	}
	if id == uuid.Nil {
		t.Fatal("created member has no id")
	}
	row, err := st.GetMember(ctx, id)
	if err != nil {
		t.Fatalf("get member: %v", err)
	}
	if row.MerchantID != merchant || row.Name != "Amina" || row.Phone != "+255700000001" {
		t.Fatalf("unexpected member: %+v", row)
	}
	if row.BalanceTZS != 0 || row.TotalSpendTZS != 0 {
		t.Fatalf("new member balance/spend = %d/%d, want 0/0", row.BalanceTZS, row.TotalSpendTZS)
	}

	if _, err := st.CreateMember(ctx, merchant, "+255700000001", "Amina Twice"); !errors.Is(err, ErrPhoneExists) {
		t.Fatalf("duplicate phone error = %v, want ErrPhoneExists", err)
	}
	if _, err := st.CreateMember(ctx, other, "+255700000001", "Amina Elsewhere"); err != nil {
		t.Fatalf("same phone on another merchant rejected: %v", err)
	}
	if _, err := st.GetMember(ctx, uuid.New()); !errors.Is(err, ErrMemberNotFound) {
		t.Fatalf("get missing member error = %v, want ErrMemberNotFound", err)
	}
}

// TestTopUpBalance credits the balance through the store and reflects it on
// the member row.
func TestTopUpBalance(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()
	member := createMember(t, st, merchant, "+255700000002")

	bal, err := st.TopUp(ctx, member.ID, 1000)
	if err != nil {
		t.Fatalf("top up 1000: %v", err)
	}
	if bal != 1000 {
		t.Fatalf("balance after first top-up = %d, want 1000", bal)
	}
	bal, err = st.TopUp(ctx, member.ID, 1000)
	if err != nil {
		t.Fatalf("top up 1000 again: %v", err)
	}
	if bal != 2000 {
		t.Fatalf("balance after second top-up = %d, want 2000", bal)
	}
	row, err := st.GetMember(ctx, member.ID)
	if err != nil {
		t.Fatalf("reload member: %v", err)
	}
	if row.BalanceTZS != 2000 {
		t.Fatalf("stored balance = %d, want 2000", row.BalanceTZS)
	}
}

// TestTopUpBelowThreshold: amounts under the 1000 TZS minimum are rejected
// before any write.
func TestTopUpBelowThreshold(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()
	member := createMember(t, st, merchant, "+255700000003")

	if _, err := st.TopUp(ctx, member.ID, 500); !errors.Is(err, ErrBelowThreshold) {
		t.Fatalf("top up 500 error = %v, want ErrBelowThreshold", err)
	}
	if _, err := st.TopUp(ctx, member.ID, 999); !errors.Is(err, ErrBelowThreshold) {
		t.Fatalf("top up 999 error = %v, want ErrBelowThreshold", err)
	}
	row, err := st.GetMember(ctx, member.ID)
	if err != nil {
		t.Fatalf("reload member: %v", err)
	}
	if row.BalanceTZS != 0 {
		t.Fatalf("balance after rejected top-ups = %d, want 0", row.BalanceTZS)
	}
	if _, err := st.TopUp(ctx, uuid.New(), 1000); !errors.Is(err, ErrMemberNotFound) {
		t.Fatalf("top up missing member error = %v, want ErrMemberNotFound", err)
	}
}

// TestTransactionsLedger: every top-up appends a ledger row carrying the
// running balance; a foreign bonus entry lands in the same ledger so the
// member's history reads newest first.
func TestTransactionsLedger(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()
	member := createMember(t, st, merchant, "+255700000004")

	for _, amount := range []int64{1000, 1500, 2000} {
		if _, err := st.TopUp(ctx, member.ID, amount); err != nil {
			t.Fatalf("top up %d: %v", amount, err)
		}
	}
	// A bonus row inserted directly must carry the correct running balance:
	// the ledger is append-only and balances are stored, not summed.
	if _, err := pool.Exec(ctx,
		`INSERT INTO loyalty_transactions (member_id, type, amount_tzs, balance_tzs)
		 VALUES ($1, 'bonus', 1000, 5500)`, member.ID); err != nil {
		t.Fatalf("insert bonus row: %v", err)
	}

	rows, next, err := st.ListTransactions(ctx, member.ID, 50, "")
	if err != nil {
		t.Fatalf("list transactions: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("transaction rows = %d, want 4", len(rows))
	}
	if next != "" {
		t.Fatalf("unexpected next cursor on a full page: %q", next)
	}
	want := []int64{5500, 4500, 2500, 1000}
	for i, row := range rows {
		if row.BalanceTZS != want[i] {
			t.Fatalf("row %d balance = %d, want %d", i, row.BalanceTZS, want[i])
		}
	}
	if rows[3].Type != "top_up" || rows[3].AmountTZS != 1000 {
		t.Fatalf("oldest row = %+v, want top_up 1000", rows[3])
	}
	if rows[0].Type != "bonus" {
		t.Fatalf("newest row type = %q, want bonus", rows[0].Type)
	}
}

// TestConcurrentTopUps: 10 parallel top-ups of 1000 on a zero balance must
// serialize to exactly 10000 with exactly 10 ledger rows — the per-member
// advisory lock keeps the running balance exact.
func TestConcurrentTopUps(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()
	member := createMember(t, st, merchant, "+255700000005")

	const workers = 10
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := st.TopUp(ctx, member.ID, 1000); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent top-up failed: %v", err)
	}

	row, err := st.GetMember(ctx, member.ID)
	if err != nil {
		t.Fatalf("reload member: %v", err)
	}
	if row.BalanceTZS != 10000 {
		t.Fatalf("balance after concurrent top-ups = %d, want 10000", row.BalanceTZS)
	}
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM loyalty_transactions WHERE member_id = $1`, member.ID).Scan(&count); err != nil {
		t.Fatalf("count ledger rows: %v", err)
	}
	if count != workers {
		t.Fatalf("ledger rows = %d, want %d", count, workers)
	}
}

// TestTiersCRUD covers create, get, list (merchant-scoped), duplicate-name
// rejection and missing-tier lookup.
func TestTiersCRUD(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	other := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	tier, err := st.CreateTier(ctx, merchant, "gold", 50000)
	if err != nil {
		t.Fatalf("create tier: %v", err)
	}
	if tier.ID == uuid.Nil || tier.ThresholdTZS != 50000 {
		t.Fatalf("unexpected tier: %+v", tier)
	}
	got, err := st.GetTier(ctx, tier.ID)
	if err != nil {
		t.Fatalf("get tier: %v", err)
	}
	if got.Name != "gold" || got.DiscountBps != 0 {
		t.Fatalf("unexpected tier: %+v", got)
	}
	if _, err := st.CreateTier(ctx, merchant, "gold", 1000); !errors.Is(err, ErrTierNameExists) {
		t.Fatalf("duplicate tier name error = %v, want ErrTierNameExists", err)
	}
	if _, err := st.GetTier(ctx, uuid.New()); !errors.Is(err, ErrTierNotFound) {
		t.Fatalf("get missing tier error = %v, want ErrTierNotFound", err)
	}

	tiers, err := st.ListTiers(ctx, merchant)
	if err != nil {
		t.Fatalf("list tiers: %v", err)
	}
	if len(tiers) != 1 || tiers[0].ID != tier.ID {
		t.Fatalf("merchant tiers = %+v, want the created tier only", tiers)
	}
	if tiers, err := st.ListTiers(ctx, other); err != nil || len(tiers) != 0 {
		t.Fatalf("other merchant tiers = %+v (err %v), want empty", tiers, err)
	}
}

// TestCustomerMembershipUpsert: the platform-wide membership row upserts on
// user_id and GetMyMemberships returns the current points.
func TestCustomerMembershipUpsert(t *testing.T) {
	pool := newTestPool(t)
	customer := setupUser(t, pool)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	if err := st.UpsertCustomerMembership(ctx, customer, merchant, uuid.Nil, 120); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if err := st.UpsertCustomerMembership(ctx, customer, merchant, uuid.Nil, 500); err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	rows, next, err := st.GetMyMemberships(ctx, customer, 20, "")
	if err != nil {
		t.Fatalf("get memberships: %v", err)
	}
	if len(rows) != 1 || next != "" {
		t.Fatalf("memberships = %+v (next %q), want exactly one row", rows, next)
	}
	if rows[0].UserID != customer || rows[0].Points != 500 {
		t.Fatalf("unexpected membership: %+v", rows[0])
	}
	if rows[0].MemberSince.IsZero() {
		t.Fatal("member_since not set")
	}
	if rows, _, err := st.GetMyMemberships(ctx, setupUser(t, pool), 20, ""); err != nil || len(rows) != 0 {
		t.Fatalf("fresh user memberships = %+v (err %v), want empty", rows, err)
	}
}

// TestListMembersPagination: 25 members page in 20 + 5 with the cursor from
// the first page.
func TestListMembersPagination(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	for i := 0; i < 25; i++ {
		createMember(t, st, merchant, fmt.Sprintf("+255700000%03d", 100+i))
	}
	page1, next, err := st.ListMembers(ctx, merchant, 20, "")
	if err != nil {
		t.Fatalf("list members page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 rows = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("missing next cursor on page 1")
	}
	page2, next2, err := st.ListMembers(ctx, merchant, 20, next)
	if err != nil {
		t.Fatalf("list members page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 rows = %d, want 5", len(page2))
	}
	if next2 != "" {
		t.Fatalf("unexpected cursor after page 2: %q", next2)
	}
	seen := map[uuid.UUID]bool{}
	for _, row := range append(page1, page2...) {
		if seen[row.ID] {
			t.Fatalf("member %s repeated across pages", row.ID)
		}
		seen[row.ID] = true
	}
	if len(seen) != 25 {
		t.Fatalf("unique members across pages = %d, want 25", len(seen))
	}
}
