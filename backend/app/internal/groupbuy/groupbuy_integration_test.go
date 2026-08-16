//go:build integration

// End-to-end tests for the group buy bounded context against real
// PostgreSQL. Run via `go test -tags integration ./internal/groupbuy/
// -count=1` after `go run ./cmd/migrate -up`.
package groupbuy

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

// newTestPool connects to DATABASE_URL and truncates only the group buy
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
		`TRUNCATE voucher_verifications, vouchers, group_buy_deals`); err != nil {
		t.Fatalf("truncate group buy tables: %v", err)
	}
	return pool
}

// setupUser inserts a users row and returns its id.
func setupUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2556%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'GroupBuy IT User') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

// createDeal inserts a live deal for the merchant and returns the row.
func createDeal(t *testing.T, st *Store, merchant uuid.UUID, total int) DealRow {
	t.Helper()
	return createDealWindow(t, st, merchant, total, time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))
}

func createDealWindow(t *testing.T, st *Store, merchant uuid.UUID, total int, start, end time.Time) DealRow {
	t.Helper()
	row, err := st.CreateDeal(context.Background(), CreateDealInput{
		MerchantID:       merchant,
		Title:            "IT deal",
		OriginalPriceTZS: 20000,
		DealPriceTZS:     10000,
		QuantityTotal:    total,
		StartAt:          start,
		EndAt:            end,
	})
	if err != nil {
		t.Fatalf("create deal: %v", err)
	}
	return row
}

// TestGroupBuyDealLifecycle covers create -> list(active) -> get, including
// the server-assigned fields (id, status active, zero sold).
func TestGroupBuyDealLifecycle(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	row := createDeal(t, st, merchant, 10)
	if row.ID == uuid.Nil {
		t.Fatal("created deal has no id")
	}
	if row.Status != "active" || row.QuantitySold != 0 {
		t.Fatalf("status/sold = %s/%d, want active/0", row.Status, row.QuantitySold)
	}
	if row.MerchantID != merchant {
		t.Fatalf("merchant = %s, want %s", row.MerchantID, merchant)
	}

	deals, _, err := st.ListDeals(ctx, "active", 50, "")
	if err != nil {
		t.Fatalf("list deals: %v", err)
	}
	found := false
	for _, d := range deals {
		if d.ID == row.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("created deal missing from the active list")
	}

	got, err := st.GetDeal(ctx, row.ID)
	if err != nil {
		t.Fatalf("get deal: %v", err)
	}
	if got.ID != row.ID || got.Title != "IT deal" || got.DealPriceTZS != 10000 {
		t.Fatalf("unexpected deal: %+v", got)
	}
	if _, err := st.GetDeal(ctx, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get missing deal error = %v, want ErrNotFound", err)
	}
}

// TestPurchaseDecrementsQuantity verifies the quantity guard: two purchases
// against a quantity-2 deal succeed and a third yields ErrQuantityExceeded;
// each voucher is active, prefixed GB-, and expires with the deal.
func TestPurchaseDecrementsQuantity(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	customer := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 2)

	first, err := st.Purchase(ctx, deal.ID, customer)
	if err != nil {
		t.Fatalf("first purchase: %v", err)
	}
	if first.Code == "" || len(first.Code) < 4 || first.Code[:3] != "GB-" {
		t.Fatalf("unexpected voucher code %q", first.Code)
	}
	if first.Status != "active" || first.UserID != customer || first.DealID != deal.ID {
		t.Fatalf("unexpected voucher: %+v", first)
	}
	if !first.ExpiresAt.Equal(deal.EndAt) {
		t.Fatalf("voucher expiry %v, want deal end %v", first.ExpiresAt, deal.EndAt)
	}
	if first.DealPriceTZS != 10000 || first.MerchantID != merchant {
		t.Fatalf("voucher projection: %+v", first)
	}

	second, err := st.Purchase(ctx, deal.ID, customer)
	if err != nil {
		t.Fatalf("second purchase: %v", err)
	}
	if second.Code == first.Code {
		t.Fatal("two purchases produced the same voucher code")
	}

	updated, err := st.GetDeal(ctx, deal.ID)
	if err != nil {
		t.Fatalf("reload deal: %v", err)
	}
	if updated.QuantitySold != 2 {
		t.Fatalf("quantity_sold = %d, want 2", updated.QuantitySold)
	}

	if _, err := st.Purchase(ctx, deal.ID, customer); !errors.Is(err, ErrQuantityExceeded) {
		t.Fatalf("third purchase error = %v, want ErrQuantityExceeded", err)
	}
}

// TestPurchaseAfterEndReturnsEnded verifies the time guard: a purchase
// against a deal whose sale window has closed yields ErrEnded, and a
// missing deal yields ErrNotFound.
func TestPurchaseAfterEndReturnsEnded(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	customer := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 5)
	if _, err := pool.Exec(ctx,
		`UPDATE group_buy_deals SET end_at = now() - interval '1 hour' WHERE id = $1`, deal.ID); err != nil {
		t.Fatalf("backdate deal: %v", err)
	}
	if _, err := st.Purchase(ctx, deal.ID, customer); !errors.Is(err, ErrEnded) {
		t.Fatalf("purchase after end error = %v, want ErrEnded", err)
	}
	if _, err := st.Purchase(ctx, uuid.New(), customer); !errors.Is(err, ErrNotFound) {
		t.Fatalf("purchase missing deal error = %v, want ErrNotFound", err)
	}
}

// TestVoucherCodeUnique verifies the codes column uniqueness constraint: a
// second insert with an existing code is rejected by PostgreSQL.
func TestVoucherCodeUnique(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	customer := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 10)
	voucher, err := st.Purchase(ctx, deal.ID, customer)
	if err != nil {
		t.Fatalf("purchase: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO vouchers (deal_id, user_id, code, status, expires_at)
		 VALUES ($1, $2, $3, 'active', now() + interval '1 day')`,
		deal.ID, customer, voucher.Code); err == nil {
		t.Fatal("duplicate voucher code insert succeeded, want unique violation")
	}
}

// TestVerifyAndRedeemVoucher walks the merchant redemption flow: a verify
// at the owning merchant succeeds (and logs), a verify at another merchant
// yields ErrNotRedeemable, the redeem flips the voucher to used, and a
// re-verify of the redeemed voucher yields ErrAlreadyUsed.
func TestVerifyAndRedeemVoucher(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	otherMerchant := setupUser(t, pool)
	customer := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 5)
	voucher, err := st.Purchase(ctx, deal.ID, customer)
	if err != nil {
		t.Fatalf("purchase: %v", err)
	}

	verified, err := st.VerifyVoucher(ctx, voucher.Code, merchant)
	if err != nil {
		t.Fatalf("verify at owning merchant: %v", err)
	}
	if verified.Status != "active" {
		t.Fatalf("verify changed status to %q, want active", verified.Status)
	}

	if _, err := st.VerifyVoucher(ctx, voucher.Code, otherMerchant); !errors.Is(err, ErrNotRedeemable) {
		t.Fatalf("verify at wrong merchant error = %v, want ErrNotRedeemable", err)
	}

	redeemed, err := st.RedeemVoucher(ctx, voucher.Code, merchant)
	if err != nil {
		t.Fatalf("redeem: %v", err)
	}
	if redeemed.Status != "used" || redeemed.RedeemedAt == nil {
		t.Fatalf("redeemed voucher = %+v, want used with redeemed_at", redeemed)
	}

	if _, err := st.VerifyVoucher(ctx, voucher.Code, merchant); !errors.Is(err, ErrAlreadyUsed) {
		t.Fatalf("re-verify error = %v, want ErrAlreadyUsed", err)
	}
	if _, err := st.RedeemVoucher(ctx, voucher.Code, merchant); !errors.Is(err, ErrAlreadyUsed) {
		t.Fatalf("double redeem error = %v, want ErrAlreadyUsed", err)
	}
	if _, err := st.VerifyVoucher(ctx, "GB-00000000", merchant); !errors.Is(err, ErrInvalidCode) {
		t.Fatalf("verify unknown code error = %v, want ErrInvalidCode", err)
	}

	history, _, err := st.VerifyHistory(ctx, merchant, 50, "")
	if err != nil {
		t.Fatalf("verify history: %v", err)
	}
	// Only successful checks are logged: the owning-merchant verify and the
	// redeem (the wrong-merchant verify returns before any log row).
	if len(history) != 2 {
		t.Fatalf("history rows = %d, want 2 (verify + redeem)", len(history))
	}
	for _, row := range history {
		if row.VoucherCode != voucher.Code {
			t.Fatalf("history voucher code = %q, want %q", row.VoucherCode, voucher.Code)
		}
		if row.MerchantID != merchant {
			t.Fatalf("history merchant = %s, want %s", row.MerchantID, merchant)
		}
	}
}

// TestExtendDealGates verifies the extension rules: a +1h extension of a
// live deal succeeds; extending past the 72-hour cap or backwards yields
// ErrInvalidExtend; extending a non-active deal yields ErrStatusConflict.
func TestExtendDealGates(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 5)

	extended, err := st.ExtendDeal(ctx, deal.ID, deal.EndAt.Add(time.Hour))
	if err != nil {
		t.Fatalf("extend +1h: %v", err)
	}
	if !extended.EndAt.Equal(deal.EndAt.Add(time.Hour)) {
		t.Fatalf("extended end = %v, want %v", extended.EndAt, deal.EndAt.Add(time.Hour))
	}

	if _, err := st.ExtendDeal(ctx, deal.ID, deal.EndAt.Add(4*24*time.Hour)); !errors.Is(err, ErrInvalidExtend) {
		t.Fatalf("extend +4d error = %v, want ErrInvalidExtend", err)
	}
	if _, err := st.ExtendDeal(ctx, deal.ID, deal.EndAt); !errors.Is(err, ErrInvalidExtend) {
		t.Fatalf("backwards extend error = %v, want ErrInvalidExtend", err)
	}
	if _, err := st.ExtendDeal(ctx, uuid.New(), deal.EndAt.Add(time.Hour)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("extend missing deal error = %v, want ErrNotFound", err)
	}

	if _, err := st.DelistDeal(ctx, extended.ID); err != nil {
		t.Fatalf("delist: %v", err)
	}
	if _, err := st.ExtendDeal(ctx, extended.ID, deal.EndAt.Add(2*time.Hour)); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("extend delisted deal error = %v, want ErrStatusConflict", err)
	}
}

// TestDelistRelist covers the delist/relist transitions: active -> delisted
// -> active, double transitions conflict, and a relist after the sale
// window closed conflicts.
func TestDelistRelist(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 5)

	delisted, err := st.DelistDeal(ctx, deal.ID)
	if err != nil {
		t.Fatalf("delist: %v", err)
	}
	if delisted.Status != "delisted" {
		t.Fatalf("status = %q, want delisted", delisted.Status)
	}
	if _, err := st.DelistDeal(ctx, deal.ID); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("double delist error = %v, want ErrStatusConflict", err)
	}

	relisted, err := st.RelistDeal(ctx, deal.ID)
	if err != nil {
		t.Fatalf("relist: %v", err)
	}
	if relisted.Status != "active" {
		t.Fatalf("status = %q, want active", relisted.Status)
	}
	if _, err := st.RelistDeal(ctx, deal.ID); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("double relist error = %v, want ErrStatusConflict", err)
	}

	// A delisted deal whose window has closed cannot relist.
	if _, err := st.DelistDeal(ctx, deal.ID); err != nil {
		t.Fatalf("re-delist: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE group_buy_deals SET end_at = now() - interval '1 hour' WHERE id = $1`, deal.ID); err != nil {
		t.Fatalf("backdate deal: %v", err)
	}
	if _, err := st.RelistDeal(ctx, deal.ID); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("relist past end error = %v, want ErrStatusConflict", err)
	}
}

// TestListDealsKeysetPagination walks 25 deals in two pages (20 + 5) with
// no overlap and a deterministic (created_at, id) order.
func TestListDealsKeysetPagination(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	const total = 25
	created := make([]DealRow, 0, total)
	for i := 0; i < total; i++ {
		created = append(created, createDeal(t, st, merchant, 3))
	}

	page1, next, err := st.ListDeals(ctx, "active", 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 size = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("page 1 has no next cursor")
	}
	page2, next2, err := st.ListDeals(ctx, "active", 20, next)
	if err != nil {
		t.Fatalf("list page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 size = %d, want 5", len(page2))
	}
	if next2 != "" {
		t.Fatalf("page 2 advertises a next cursor %q, want none", next2)
	}

	seen := make(map[uuid.UUID]bool, total)
	for _, row := range append(append([]DealRow{}, page1...), page2...) {
		if seen[row.ID] {
			t.Fatalf("deal %s returned twice across pages", row.ID)
		}
		seen[row.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("unique deals = %d, want %d", len(seen), total)
	}

	all, _, err := st.ListDeals(ctx, "active", 50, "")
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	for i := range page1 {
		if page1[i].ID != all[i].ID {
			t.Fatalf("page 1 row %d = %s, want %s", i, page1[i].ID, all[i].ID)
		}
	}
	for i := range page2 {
		if page2[i].ID != all[20+i].ID {
			t.Fatalf("page 2 row %d = %s, want %s", i, page2[i].ID, all[20+i].ID)
		}
	}

	if _, _, err := st.ListDeals(ctx, "active", 20, "not-a-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("malformed cursor error = %v, want ErrInvalidCursor", err)
	}
}

// TestPurchaseConcurrency fires 10 concurrent purchases against a
// quantity-1 deal; the FOR UPDATE guard admits exactly one winner.
func TestPurchaseConcurrency(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	customer := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	deal := createDeal(t, st, merchant, 1)

	const workers = 10
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := st.Purchase(ctx, deal.ID, customer)
			if err == nil {
				mu.Lock()
				winners++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if winners != 1 {
		t.Fatalf("winners = %d, want exactly 1", winners)
	}
	final, err := st.GetDeal(ctx, deal.ID)
	if err != nil {
		t.Fatalf("get deal: %v", err)
	}
	if final.QuantitySold != 1 {
		t.Fatalf("quantity_sold = %d, want 1", final.QuantitySold)
	}
	vouchers, _, err := st.ListMyVouchers(ctx, customer, 50, "")
	if err != nil {
		t.Fatalf("list vouchers: %v", err)
	}
	if len(vouchers) != 1 {
		t.Fatalf("vouchers = %d, want exactly 1", len(vouchers))
	}
}
