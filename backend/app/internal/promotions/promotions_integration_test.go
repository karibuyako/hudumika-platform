//go:build integration

// End-to-end tests for the promotions bounded context against real
// PostgreSQL. Run via `go test -tags integration ./internal/promotions/
// -count=1` after `go run ./cmd/migrate -up`.
package promotions

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

// newTestPool connects to DATABASE_URL and truncates only the promotions
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
		`TRUNCATE coupons, coupon_campaigns, promotions`); err != nil {
		t.Fatalf("truncate promotions tables: %v", err)
	}
	return pool
}

// setupUser inserts a users row (the merchant/customer identity for this
// milestone) and returns its id.
func setupUser(t *testing.T, pool *pgxpool.Pool, label string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2557%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id`,
		phone, "IT "+label).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

func promoInput(merchant uuid.UUID, title string, status string) PromotionCreateInput {
	return PromotionCreateInput{
		MerchantID: merchant,
		Type:       "discount",
		Title:      title,
		BudgetTZS:  int64Ptr(500000),
		Status:     status,
		StartsAt:   time.Now().Add(-time.Hour),
		EndsAt:     time.Now().Add(72 * time.Hour),
	}
}

func int64Ptr(v int64) *int64 { return &v }

// TestCreatePromotionCRUDAndPause exercises create, get, the live->paused
// guard, the conflict on a second pause, resume, and the not-found path.
func TestCreatePromotionCRUDAndPause(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Promo Merchant")
	st := NewStore(pool)

	row, err := st.CreatePromotion(context.Background(), promoInput(merchant, "IT Pause Test", "live"))
	if err != nil {
		t.Fatalf("create promotion: %v", err)
	}
	if row.Status != "live" || row.Type != "discount" {
		t.Fatalf("row = %s/%s, want live/discount", row.Status, row.Type)
	}
	if row.SpendTZS != 0 || row.RedeemCount != 0 {
		t.Fatalf("fresh spend/redeem = %d/%d, want 0/0", row.SpendTZS, row.RedeemCount)
	}

	got, err := st.GetPromotion(context.Background(), row.ID)
	if err != nil {
		t.Fatalf("get promotion: %v", err)
	}
	if got.Title != "IT Pause Test" || got.MerchantID != merchant {
		t.Fatalf("get promotion mismatch: %+v", got)
	}

	if err := st.PausePromotion(context.Background(), row.ID); err != nil {
		t.Fatalf("pause promotion: %v", err)
	}
	got, _ = st.GetPromotion(context.Background(), row.ID)
	if got.Status != "paused" {
		t.Fatalf("status after pause = %s, want paused", got.Status)
	}
	if err := st.PausePromotion(context.Background(), row.ID); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("second pause err = %v, want ErrStatusConflict", err)
	}
	if err := st.ResumePromotion(context.Background(), row.ID); err != nil {
		t.Fatalf("resume promotion: %v", err)
	}
	got, _ = st.GetPromotion(context.Background(), row.ID)
	if got.Status != "live" {
		t.Fatalf("status after resume = %s, want live", got.Status)
	}
	if err := st.PausePromotion(context.Background(), uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pause missing promotion err = %v, want ErrNotFound", err)
	}
}

// TestListPromotionsPagination creates 25 promotions and walks two pages of
// 20 + 5 with the keyset cursor.
func TestListPromotionsPagination(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Pagination Merchant")
	other := setupUser(t, pool, "Other Merchant")
	st := NewStore(pool)

	for i := 0; i < 25; i++ {
		if _, err := st.CreatePromotion(context.Background(),
			promoInput(merchant, fmt.Sprintf("IT Pag %02d", i), "draft")); err != nil {
			t.Fatalf("create promotion %d: %v", i, err)
		}
	}
	if _, err := st.CreatePromotion(context.Background(),
		promoInput(other, "IT Pag Other", "draft")); err != nil {
		t.Fatalf("create other promotion: %v", err)
	}

	page1, next, err := st.ListPromotions(context.Background(), merchant, "", 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 length = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("page 1 missing next cursor")
	}
	page2, next2, err := st.ListPromotions(context.Background(), merchant, "", 20, next)
	if err != nil {
		t.Fatalf("list page 2: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("page 2 length = %d, want 5", len(page2))
	}
	if next2 != "" {
		t.Fatalf("page 2 next = %q, want empty", next2)
	}

	filtered, _, err := st.ListPromotions(context.Background(), merchant, "draft", 50, "")
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if len(filtered) != 25 {
		t.Fatalf("draft count = %d, want 25", len(filtered))
	}
	if _, _, err := st.ListPromotions(context.Background(), merchant, "", 20, "not-a-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("bad cursor err = %v, want ErrInvalidCursor", err)
	}
}

// TestPromotionPerformance reflects spend_tzs, redeem_count and the
// performance jsonb when they change out-of-band.
func TestPromotionPerformance(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Perf Merchant")
	st := NewStore(pool)

	row, err := st.CreatePromotion(context.Background(), promoInput(merchant, "IT Perf", "live"))
	if err != nil {
		t.Fatalf("create promotion: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE promotions SET spend_tzs = 25000, redeem_count = 9,
		 performance = '{"impressions": 1000, "clicks": 80, "attributed_revenue_tzs": 40000}'::jsonb
		 WHERE id = $1`, row.ID); err != nil {
		t.Fatalf("set performance: %v", err)
	}

	perf, err := st.Performance(context.Background(), row.ID)
	if err != nil {
		t.Fatalf("performance: %v", err)
	}
	if perf.SpendTZS != 25000 || perf.RedeemCount != 9 {
		t.Fatalf("spend/redeem = %d/%d, want 25000/9", perf.SpendTZS, perf.RedeemCount)
	}
	if perf.Performance["impressions"] != float64(1000) || perf.Performance["clicks"] != float64(80) {
		t.Fatalf("performance jsonb = %v", perf.Performance)
	}
	if _, err := st.Performance(context.Background(), uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing performance err = %v, want ErrNotFound", err)
	}
}

// TestCouponCampaignClaims exercises create, budget exhaustion (quantity 2,
// third claim sold out) and code uniqueness.
func TestCouponCampaignClaims(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Coupon Merchant")
	customer1 := setupUser(t, pool, "Coupon Customer 1")
	customer2 := setupUser(t, pool, "Coupon Customer 2")
	customer3 := setupUser(t, pool, "Coupon Customer 3")
	st := NewStore(pool)

	camp, err := st.CreateCouponCampaign(context.Background(), CampaignCreateInput{
		MerchantID:      merchant,
		Title:           "IT Launch 10k",
		DiscountTZS:     10000,
		MinimumSpendTZS: 50000,
		Quantity:        2,
		ValidUntil:      time.Now().Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create campaign: %v", err)
	}
	if camp.Status != "live" || camp.Quantity != 2 || camp.ClaimedCount != 0 {
		t.Fatalf("campaign = %+v", camp)
	}

	first, err := st.ClaimCoupon(context.Background(), camp.ID, customer1)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if first.Status != "claimed" || first.CampaignID != camp.ID || first.CustomerUserID == nil || *first.CustomerUserID != customer1 {
		t.Fatalf("first coupon = %+v", first)
	}
	if first.Code == "" || len(first.Code) != 11 || first.Code[:3] != "CP-" {
		t.Fatalf("coupon code = %q, want CP-<8 hex>", first.Code)
	}
	if first.ClaimedAt == nil || first.ExpiresAt == nil {
		t.Fatalf("coupon timestamps missing: %+v", first)
	}

	second, err := st.ClaimCoupon(context.Background(), camp.ID, customer2)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if second.Code == first.Code {
		t.Fatalf("duplicate coupon code %q", second.Code)
	}

	if _, err := st.ClaimCoupon(context.Background(), camp.ID, customer3); !errors.Is(err, ErrSoldOut) {
		t.Fatalf("third claim err = %v, want ErrSoldOut", err)
	}

	campAfter, err := st.GetCampaign(context.Background(), camp.ID)
	if err != nil {
		t.Fatalf("get campaign: %v", err)
	}
	if campAfter.ClaimedCount != 2 {
		t.Fatalf("claimed_count = %d, want 2", campAfter.ClaimedCount)
	}
}

// TestClaimDuplicateCampaign enforces one coupon per (campaign, user).
func TestClaimDuplicateCampaign(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Dup Merchant")
	customer := setupUser(t, pool, "Dup Customer")
	st := NewStore(pool)

	camp, err := st.CreateCouponCampaign(context.Background(), CampaignCreateInput{
		MerchantID:  merchant,
		Title:       "IT Dup",
		DiscountTZS: 5000,
		Quantity:    10,
		ValidUntil:  time.Now().Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create campaign: %v", err)
	}
	if _, err := st.ClaimCoupon(context.Background(), camp.ID, customer); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if _, err := st.ClaimCoupon(context.Background(), camp.ID, customer); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("duplicate claim err = %v, want ErrAlreadyClaimed", err)
	}
}

// TestClaimExpiredCampaign rejects claims on a campaign whose valid_until
// has passed.
func TestClaimExpiredCampaign(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Expiry Merchant")
	customer := setupUser(t, pool, "Expiry Customer")
	st := NewStore(pool)

	camp, err := st.CreateCouponCampaign(context.Background(), CampaignCreateInput{
		MerchantID:  merchant,
		Title:       "IT Expiry",
		DiscountTZS: 5000,
		Quantity:    10,
		ValidUntil:  time.Now().Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create campaign: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE coupon_campaigns SET valid_until = now() - interval '1 hour' WHERE id = $1`, camp.ID); err != nil {
		t.Fatalf("backdate campaign: %v", err)
	}
	if _, err := st.ClaimCoupon(context.Background(), camp.ID, customer); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired claim err = %v, want ErrExpired", err)
	}
}

// TestListMyCoupons returns the user's claimed coupons with the status
// filter.
func TestListMyCoupons(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Wallet Merchant")
	customer := setupUser(t, pool, "Wallet Customer")
	st := NewStore(pool)

	var ids []uuid.UUID
	for i := 0; i < 3; i++ {
		camp, err := st.CreateCouponCampaign(context.Background(), CampaignCreateInput{
			MerchantID:  merchant,
			Title:       fmt.Sprintf("IT Wallet %d", i),
			DiscountTZS: int64(1000 * (i + 1)),
			Quantity:    5,
			ValidUntil:  time.Now().Add(48 * time.Hour),
		})
		if err != nil {
			t.Fatalf("create campaign %d: %v", i, err)
		}
		ids = append(ids, camp.ID)
	}
	for _, id := range ids {
		if _, err := st.ClaimCoupon(context.Background(), id, customer); err != nil {
			t.Fatalf("claim %s: %v", id, err)
		}
	}

	rows, next, err := st.ListMyCoupons(context.Background(), customer, "", 50, "")
	if err != nil {
		t.Fatalf("list my coupons: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("coupons = %d, want 3", len(rows))
	}
	if next != "" {
		t.Fatalf("next = %q, want empty", next)
	}
	for _, row := range rows {
		if row.CustomerUserID == nil || *row.CustomerUserID != customer {
			t.Fatalf("coupon owner mismatch: %+v", row)
		}
		if row.Status != "claimed" {
			t.Fatalf("coupon status = %s, want claimed", row.Status)
		}
	}

	claimed, _, err := st.ListMyCoupons(context.Background(), customer, "claimed", 50, "")
	if err != nil {
		t.Fatalf("list claimed: %v", err)
	}
	if len(claimed) != 3 {
		t.Fatalf("claimed coupons = %d, want 3", len(claimed))
	}
	used, _, err := st.ListMyCoupons(context.Background(), customer, "used", 50, "")
	if err != nil {
		t.Fatalf("list used: %v", err)
	}
	if len(used) != 0 {
		t.Fatalf("used coupons = %d, want 0", len(used))
	}
}

// TestConcurrentClaimsBudgetOne races ten users against a budget of one:
// the row lock in ClaimCoupon guarantees exactly one winner.
func TestConcurrentClaimsBudgetOne(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool, "Race Merchant")
	st := NewStore(pool)

	camp, err := st.CreateCouponCampaign(context.Background(), CampaignCreateInput{
		MerchantID:  merchant,
		Title:       "IT Race",
		DiscountTZS: 1000,
		Quantity:    1,
		ValidUntil:  time.Now().Add(48 * time.Hour),
	})
	if err != nil {
		t.Fatalf("create campaign: %v", err)
	}

	const racers = 10
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, soldOut := 0, 0
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			user := setupUser(t, pool, fmt.Sprintf("Racer %d", i))
			_, err := st.ClaimCoupon(context.Background(), camp.ID, user)
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrSoldOut):
				soldOut++
			default:
				t.Errorf("unexpected claim error: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if wins != 1 {
		t.Fatalf("wins = %d, want exactly 1", wins)
	}
	if soldOut != racers-1 {
		t.Fatalf("sold out = %d, want %d", soldOut, racers-1)
	}
	campAfter, err := st.GetCampaign(context.Background(), camp.ID)
	if err != nil {
		t.Fatalf("get campaign: %v", err)
	}
	if campAfter.ClaimedCount != 1 {
		t.Fatalf("claimed_count = %d, want 1", campAfter.ClaimedCount)
	}
}
