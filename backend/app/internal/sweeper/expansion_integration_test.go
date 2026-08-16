//go:build integration

// Integration tests for the expansion sweeper jobs
// (SendPreOrderReminders, TickPromotions, ExpireClosureProtection,
// ReopenScheduledStores). They require a reachable database
// (DATABASE_URL); no Redis is needed. Only rows created by these tests
// are touched: every insert is tracked and deleted in cleanup; nothing is
// truncated. Rows the reopen test creates (chain_stores, store_settings)
// cascade away with their merchants and users.
package sweeper

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// expansionFixture owns the pool plus every row a test inserted, so
// cleanup deletes exactly those rows and nothing else.
type expansionFixture struct {
	pool          *pgxpool.Pool
	users         []uuid.UUID
	merchants     []uuid.UUID
	orders        []uuid.UUID
	notifications []uuid.UUID
	promotions    []uuid.UUID
	deals         []uuid.UUID
	closures      []uuid.UUID
}

func setupExpansion(t *testing.T) *expansionFixture {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" {
		t.Skip("DATABASE_URL not set; skipping sweeper expansion integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	f := &expansionFixture{pool: pool}
	t.Cleanup(func() {
		// Reminders created by the jobs carry the test users; delete them
		// with the users rather than leaving feed rows behind.
		if len(f.users) > 0 {
			if _, err := pool.Exec(ctx,
				`DELETE FROM notifications WHERE user_id = ANY($1)`, f.users); err != nil {
				t.Errorf("cleanup reminders: %v", err)
			}
		}
		for _, id := range f.notifications {
			if _, err := pool.Exec(ctx, `DELETE FROM notifications WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup notification %s: %v", id, err)
			}
		}
		// Deletion order matters for the users FK: deals, promotions and
		// orders reference users(id) with NO ACTION, so they go first.
		for _, id := range f.closures {
			if _, err := pool.Exec(ctx, `DELETE FROM closure_protection WHERE merchant_id = $1`, id); err != nil {
				t.Errorf("cleanup closure %s: %v", id, err)
			}
		}
		for _, id := range f.deals {
			if _, err := pool.Exec(ctx, `DELETE FROM group_buy_deals WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup deal %s: %v", id, err)
			}
		}
		for _, id := range f.promotions {
			if _, err := pool.Exec(ctx, `DELETE FROM promotions WHERE id = $1`, id); err != nil {
				t.Errorf("cleanup promotion %s: %v", id, err)
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

func (f *expansionFixture) newUser(t *testing.T) uuid.UUID {
	t.Helper()
	phone := fmt.Sprintf("+25588%09d%s", time.Now().UnixNano()%1_000_000_000, uuid.NewString()[:4])
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO users (phone) VALUES ($1) RETURNING id`, phone).Scan(&id); err != nil {
		t.Fatalf("create user: %v", err)
	}
	f.users = append(f.users, id)
	return id
}

func (f *expansionFixture) newMerchant(t *testing.T, owner uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name)
		 VALUES ($1, $2) RETURNING id`,
		owner, "sweeper-expansion-merchant-"+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatalf("create merchant: %v", err)
	}
	f.merchants = append(f.merchants, id)
	return id
}

// newScheduledOrder inserts an order with the given status and slot.
func (f *expansionFixture) newScheduledOrder(t *testing.T, customerID uuid.UUID, status string, scheduledAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO orders (customer_user_id, merchant_id, status, scheduled_at)
		 VALUES ($1, $2, $3, $4) RETURNING id`,
		customerID, uuid.New(), status, scheduledAt).Scan(&id); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	f.orders = append(f.orders, id)
	return id
}

// newPromotion inserts a promotion owned by the given merchant user.
func (f *expansionFixture) newPromotion(t *testing.T, merchantID uuid.UUID, status string, startsAt, endsAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO promotions (merchant_id, type, title, status, starts_at, ends_at)
		 VALUES ($1, 'discount', $2, $3, $4, $5) RETURNING id`,
		merchantID, "sweeper-expansion-promo-"+uuid.NewString()[:8], status, startsAt, endsAt).Scan(&id); err != nil {
		t.Fatalf("insert promotion: %v", err)
	}
	f.promotions = append(f.promotions, id)
	return id
}

// newDeal inserts a group-buy deal owned by the given merchant user.
func (f *expansionFixture) newDeal(t *testing.T, merchantID uuid.UUID, status string, startAt, endAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := f.pool.QueryRow(context.Background(),
		`INSERT INTO group_buy_deals (merchant_id, title, original_price_tzs, deal_price_tzs,
			quantity_total, start_at, end_at, status)
		 VALUES ($1, $2, 10000, 8000, 10, $3, $4, $5) RETURNING id`,
		merchantID, "sweeper-expansion-deal-"+uuid.NewString()[:8], startAt, endAt, status).Scan(&id); err != nil {
		t.Fatalf("insert deal: %v", err)
	}
	f.deals = append(f.deals, id)
	return id
}

// newClosure inserts a closure-protection row for the merchant
// (closure_protection is keyed by merchant_id).
func (f *expansionFixture) newClosure(t *testing.T, merchantID uuid.UUID, usedClosures int, renewalDate time.Time) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO closure_protection (merchant_id, used_closures, renewal_date)
		 VALUES ($1, $2, $3)`,
		merchantID, usedClosures, renewalDate); err != nil {
		t.Fatalf("insert closure protection: %v", err)
	}
	f.closures = append(f.closures, merchantID)
}

// newChainStore inserts one chain_stores row for the merchant (cleaned up
// with the merchant via ON DELETE CASCADE).
func (f *expansionFixture) newChainStore(t *testing.T, owner, merchant uuid.UUID, active bool) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO chain_stores (owner_user_id, merchant_id, name, active)
		 VALUES ($1, $2, $3, $4)`,
		owner, merchant, "sweeper-reopen-store-"+uuid.NewString()[:8], active); err != nil {
		t.Fatalf("insert chain store: %v", err)
	}
}

// setReopenMarker stores the given raw opening_hours jsonb in
// store_settings for the merchant (cleaned up with the merchant via ON
// DELETE CASCADE).
func (f *expansionFixture) setReopenMarker(t *testing.T, merchant uuid.UUID, rawHours string) {
	t.Helper()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO store_settings (merchant_id, opening_hours)
		 VALUES ($1, $2::jsonb)`,
		merchant, rawHours); err != nil {
		t.Fatalf("set reopen marker %s: %v", rawHours, err)
	}
}

// assertReopenMarker reads whether the merchant's store_settings carries
// the scheduled_reopen marker.
func (f *expansionFixture) assertReopenMarker(t *testing.T, merchant uuid.UUID, want bool) {
	t.Helper()
	var has bool
	if err := f.pool.QueryRow(context.Background(),
		`SELECT opening_hours ? 'scheduled_reopen' FROM store_settings WHERE merchant_id = $1`, merchant).Scan(&has); err != nil {
		t.Fatalf("read reopen marker for %s: %v", merchant, err)
	}
	if has != want {
		t.Errorf("reopen marker on %s present = %v, want %v", merchant, has, want)
	}
}

// assertNoInactiveStores fails when the merchant still has an inactive
// chain store.
func (f *expansionFixture) assertNoInactiveStores(t *testing.T, merchant uuid.UUID) {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM chain_stores WHERE merchant_id = $1 AND NOT active`, merchant).Scan(&n); err != nil {
		t.Fatalf("count inactive chain stores for %s: %v", merchant, err)
	}
	if n != 0 {
		t.Errorf("merchant %s still has %d inactive chain stores, want 0", merchant, n)
	}
}

// countReminders counts reminder notifications (type pre_order_reminder)
// for the user whose body carries the given order id.
func countReminders(t *testing.T, pool *pgxpool.Pool, userID, orderID uuid.UUID) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM notifications
		 WHERE user_id = $1 AND type = 'pre_order_reminder'
		   AND body LIKE '%' || $2::text || '%'`, userID, orderID).Scan(&n); err != nil {
		t.Fatalf("count reminders: %v", err)
	}
	return n
}

// assertStatus reads the status of the row in table (a compile-time
// constant here) and compares it to want.
func assertStatus(t *testing.T, pool *pgxpool.Pool, table string, id uuid.UUID, want string) {
	t.Helper()
	var got string
	if err := pool.QueryRow(context.Background(),
		fmt.Sprintf(`SELECT status FROM %s WHERE id = $1`, table), id).Scan(&got); err != nil {
		t.Fatalf("read %s %s status: %v", table, id, err)
	}
	if got != want {
		t.Errorf("%s %s status = %q, want %q", table, id, got, want)
	}
}

// TestSendPreOrderRemindersCreatesOncePerDuePreOrder: paid and
// merchant_accepted pre-orders whose slot is inside the 2h lead window
// get exactly one in-app reminder (type pre_order_reminder, the order id
// embedded in the body); orders outside the window or with other statuses
// are skipped; a second run reminds nothing new.
func TestSendPreOrderRemindersCreatesOncePerDuePreOrder(t *testing.T) {
	f := setupExpansion(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	customerA := f.newUser(t)
	customerB := f.newUser(t)
	customerC := f.newUser(t)

	dueA := f.newScheduledOrder(t, customerA, "paid", time.Now().Add(time.Hour))
	dueB := f.newScheduledOrder(t, customerB, "merchant_accepted", time.Now().Add(45*time.Minute))
	f.newScheduledOrder(t, customerC, "paid", time.Now().Add(3*time.Hour))         // outside window
	f.newScheduledOrder(t, customerA, "cancelled", time.Now().Add(30*time.Minute)) // wrong status

	n, err := s.SendPreOrderReminders(ctx)
	if err != nil {
		t.Fatalf("send reminders: %v", err)
	}
	if n != 2 {
		t.Fatalf("reminders sent = %d, want 2", n)
	}

	var typ, title, body string
	if err := f.pool.QueryRow(ctx,
		`SELECT type, title, body FROM notifications
		 WHERE user_id = $1 AND type = 'pre_order_reminder'
		   AND body LIKE '%' || $2::text || '%'`,
		customerA, dueA).Scan(&typ, &title, &body); err != nil {
		t.Fatalf("read reminder: %v", err)
	}
	if typ != reminderType {
		t.Errorf("reminder type = %q, want %q", typ, reminderType)
	}
	if title != reminderTitle {
		t.Errorf("reminder title = %q, want %q", title, reminderTitle)
	}
	if !strings.Contains(body, dueA.String()) {
		t.Errorf("reminder body %q does not carry order id %s", body, dueA)
	}
	if got := countReminders(t, f.pool, customerB, dueB); got != 1 {
		t.Errorf("reminders for dueB = %d, want 1", got)
	}
	if got := countReminders(t, f.pool, customerC, uuid.Nil); got != 0 {
		t.Errorf("reminders for out-of-window order = %d, want 0", got)
	}

	if n, err := s.SendPreOrderReminders(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
	if got := countReminders(t, f.pool, customerA, dueA); got != 1 {
		t.Errorf("reminders for dueA after second run = %d, want 1 (no duplicate)", got)
	}
}

// TestTickPromotionsTicksDueStatuses: draft promotions whose start passed
// go live, live ones whose end passed are ended, and deals still active
// past end_at are ended; paused promotions and future drafts/deals are
// untouched; a second run ticks nothing.
func TestTickPromotionsTicksDueStatuses(t *testing.T) {
	f := setupExpansion(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)
	merchant := f.newUser(t)

	now := time.Now()
	draftDue := f.newPromotion(t, merchant, "draft", now.Add(-time.Hour), now.Add(24*time.Hour))
	liveDue := f.newPromotion(t, merchant, "live", now.Add(-48*time.Hour), now.Add(-time.Hour))
	paused := f.newPromotion(t, merchant, "paused", now.Add(-48*time.Hour), now.Add(-time.Hour))
	futureDraft := f.newPromotion(t, merchant, "draft", now.Add(24*time.Hour), now.Add(48*time.Hour))
	dealDue := f.newDeal(t, merchant, "active", now.Add(-48*time.Hour), now.Add(-time.Hour))
	futureDeal := f.newDeal(t, merchant, "active", now.Add(-48*time.Hour), now.Add(24*time.Hour))

	n, err := s.TickPromotions(ctx)
	if err != nil {
		t.Fatalf("tick promotions: %v", err)
	}
	if n != 3 {
		t.Fatalf("ticked = %d, want 3", n)
	}
	assertStatus(t, f.pool, "promotions", draftDue, "live")
	assertStatus(t, f.pool, "promotions", liveDue, "ended")
	assertStatus(t, f.pool, "promotions", paused, "paused")
	assertStatus(t, f.pool, "promotions", futureDraft, "draft")
	assertStatus(t, f.pool, "group_buy_deals", dealDue, "ended")
	assertStatus(t, f.pool, "group_buy_deals", futureDeal, "active")

	if n, err := s.TickPromotions(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
}

// TestExpireClosureProtectionResetsCounter: plans whose renewal date
// arrived reset their used-closures counter and roll the renewal date
// forward 365 days; future plans are untouched; a second run renews
// nothing.
func TestExpireClosureProtectionResetsCounter(t *testing.T) {
	f := setupExpansion(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	due := f.newMerchant(t, f.newUser(t))
	future := f.newMerchant(t, f.newUser(t))
	yesterday := time.Now().AddDate(0, 0, -1)
	nextYear := time.Now().AddDate(1, 0, 0)
	f.newClosure(t, due, 3, yesterday)
	f.newClosure(t, future, 1, nextYear)

	n, err := s.ExpireClosureProtection(ctx)
	if err != nil {
		t.Fatalf("expire closure protection: %v", err)
	}
	if n != 1 {
		t.Fatalf("renewed = %d, want 1", n)
	}

	var used int
	var renewal time.Time
	if err := f.pool.QueryRow(ctx,
		`SELECT used_closures, renewal_date FROM closure_protection WHERE merchant_id = $1`, due).
		Scan(&used, &renewal); err != nil {
		t.Fatalf("read renewed closure: %v", err)
	}
	if used != 0 {
		t.Errorf("due closure used_closures = %d, want 0 after renewal", used)
	}
	want := time.Date(yesterday.Year(), yesterday.Month(), yesterday.Day(), 0, 0, 0, 0, time.UTC).
		AddDate(0, 0, 365)
	if !renewal.Equal(want) {
		t.Errorf("due closure renewal_date = %v, want %v (+365 days)", renewal, want)
	}

	var futureUsed int
	var futureRenewal time.Time
	if err := f.pool.QueryRow(ctx,
		`SELECT used_closures, renewal_date FROM closure_protection WHERE merchant_id = $1`, future).
		Scan(&futureUsed, &futureRenewal); err != nil {
		t.Fatalf("read future closure: %v", err)
	}
	if futureUsed != 1 {
		t.Errorf("future closure used_closures = %d, want 1 (untouched)", futureUsed)
	}
	if !futureRenewal.Equal(time.Date(nextYear.Year(), nextYear.Month(), nextYear.Day(), 0, 0, 0, 0, time.UTC)) {
		t.Errorf("future closure renewal_date = %v, want %v (untouched)", futureRenewal, nextYear)
	}

	if n, err := s.ExpireClosureProtection(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
}

// TestRunAllAppliesExpansionJobsTogether: one sweep cycle applies every
// expansion job — reminders, promotion/deal ticks and closure renewal —
// alongside the existing jobs (which are no-ops for this fixture: no
// deadlines, vouchers or exports). runAll captures each job's error
// separately, so one failing job can never starve the rest; a second
// cycle applies nothing new.
func TestRunAllAppliesExpansionJobsTogether(t *testing.T) {
	f := setupExpansion(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	customer := f.newUser(t)
	merchantUser := f.newUser(t)
	merchant := f.newMerchant(t, merchantUser)
	now := time.Now()

	order := f.newScheduledOrder(t, customer, "paid", now.Add(time.Hour))
	promo := f.newPromotion(t, merchantUser, "draft", now.Add(-time.Hour), now.Add(24*time.Hour))
	deal := f.newDeal(t, merchantUser, "active", now.Add(-48*time.Hour), now.Add(-time.Hour))
	f.newClosure(t, merchant, 2, now.AddDate(0, 0, -1))

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("run once: %v", err)
	}

	if got := countReminders(t, f.pool, customer, order); got != 1 {
		t.Errorf("reminders for order = %d, want 1", got)
	}
	assertStatus(t, f.pool, "promotions", promo, "live")
	assertStatus(t, f.pool, "group_buy_deals", deal, "ended")
	var used int
	if err := f.pool.QueryRow(ctx,
		`SELECT used_closures FROM closure_protection WHERE merchant_id = $1`, merchant).Scan(&used); err != nil {
		t.Fatalf("read closure: %v", err)
	}
	if used != 0 {
		t.Errorf("used_closures = %d, want 0 after renewal", used)
	}

	if n, err := s.ReopenScheduledStores(ctx); err != nil || n != 0 {
		t.Fatalf("reopen scheduled stores: n=%d err=%v, want 0 nil (no markers in this fixture)", n, err)
	}

	if err := s.RunOnce(ctx); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if got := countReminders(t, f.pool, customer, order); got != 1 {
		t.Errorf("reminders after second run = %d, want 1", got)
	}
}

// TestReopenScheduledStoresReopensDueMarkedStores: a merchant whose
// {"scheduled_reopen": "<RFC3339>"} marker time passed and who has at
// least one inactive chain store gets every inactive store flipped back
// to active and the marker removed, in one run; stores that were already
// active stay untouched. Not-yet-due markers, markers on merchants with
// no inactive stores, and malformed markers are all left alone (a
// malformed marker never errors the job); a second run reopens nothing.
func TestReopenScheduledStoresReopensDueMarkedStores(t *testing.T) {
	f := setupExpansion(t)
	ctx := context.Background()
	s := newPoolSweeper(f.pool)

	// merchants.owner_user_id is unique, so every fixture merchant gets
	// its own owner.
	dueOwner := f.newUser(t)
	futureOwner := f.newUser(t)
	noMarkerOwner := f.newUser(t)
	alreadyActiveOwner := f.newUser(t)
	due := f.newMerchant(t, dueOwner)
	future := f.newMerchant(t, futureOwner)
	noMarker := f.newMerchant(t, noMarkerOwner)
	alreadyActive := f.newMerchant(t, alreadyActiveOwner)

	// chain_stores is UNIQUE (owner_user_id, merchant_id) — one row per
	// store — so every fixture merchant gets exactly one chain store.
	f.newChainStore(t, dueOwner, due, false)
	f.newChainStore(t, futureOwner, future, false)
	f.newChainStore(t, noMarkerOwner, noMarker, false)
	f.newChainStore(t, alreadyActiveOwner, alreadyActive, true)

	now := time.Now()
	f.setReopenMarker(t, due, fmt.Sprintf(`{"scheduled_reopen": %q}`, now.Add(-time.Hour).UTC().Format(time.RFC3339)))
	f.setReopenMarker(t, future, fmt.Sprintf(`{"scheduled_reopen": %q}`, now.Add(24*time.Hour).UTC().Format(time.RFC3339)))
	f.setReopenMarker(t, alreadyActive, fmt.Sprintf(`{"scheduled_reopen": %q}`, now.Add(-time.Hour).UTC().Format(time.RFC3339)))
	f.setReopenMarker(t, noMarker, `{"scheduled_reopen": "not-a-time"}`)

	n, err := s.ReopenScheduledStores(ctx)
	if err != nil {
		t.Fatalf("reopen scheduled stores: %v", err)
	}
	if n != 1 {
		t.Fatalf("reopened = %d, want 1", n)
	}

	// The due merchant's inactive store is active again and the marker
	// is gone.
	f.assertNoInactiveStores(t, due)
	f.assertReopenMarker(t, due, false)
	// Not due yet: store stays closed, marker stays.
	f.assertReopenMarker(t, future, true)
	if n, err := s.ReopenScheduledStores(ctx); err != nil || n != 0 {
		t.Fatalf("reopen with only future markers: n=%d err=%v, want 0 nil", n, err)
	}
	// Already-active stores: marker stays (never cleared for a merchant
	// with no inactive stores).
	f.assertReopenMarker(t, alreadyActive, true)
	// Malformed marker: skipped, never an error, store stays closed.
	f.assertReopenMarker(t, noMarker, true)

	// A second run reopens nothing: the marker removal is atomic with
	// the reopen, so no store is ever closed with the marker gone.
	if n, err := s.ReopenScheduledStores(ctx); err != nil || n != 0 {
		t.Fatalf("second run: n=%d err=%v, want 0 nil", n, err)
	}
}
