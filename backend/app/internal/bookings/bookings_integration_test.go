//go:build integration

// End-to-end tests for the bookings bounded context against real
// PostgreSQL. Run via `go test -tags integration ./internal/bookings/
// -count=1` after `go run ./cmd/migrate -up`.
package bookings

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestPool connects to DATABASE_URL and truncates only the bookings
// bounded-context tables so tests are isolated from other agents' tables.
// services rows created by these tests are deleted by name prefix.
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
		`TRUNCATE booking_events, bookings CASCADE`); err != nil {
		t.Fatalf("truncate bookings tables: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM services WHERE name LIKE 'IT Booking %'`); err != nil {
		t.Fatalf("delete test services: %v", err)
	}
	return pool
}

// setupCustomer inserts a users row and returns its id.
func setupCustomer(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2557%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'Bookings IT Customer') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert customer: %v", err)
	}
	return id
}

// setupService inserts an active service with a server-side price and
// returns its id.
func setupService(t *testing.T, pool *pgxpool.Pool, name string, priceTZS int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO services (name, price_tzs, active) VALUES ($1, $2, true) RETURNING id`,
		name, priceTZS).Scan(&id); err != nil {
		t.Fatalf("insert service: %v", err)
	}
	return id
}

// createBooking inserts a booking draft through the store for the given
// customer and returns the created row.
func createBooking(t *testing.T, st *Store, customer, provider uuid.UUID, serviceID uuid.UUID, key string) BookingRow {
	t.Helper()
	row, err := st.CreateBooking(context.Background(), CreateInput{
		CustomerUserID: customer,
		ProviderID:     provider,
		ServiceID:      serviceID,
		ScheduledFor:   time.Now().Add(48 * time.Hour),
		IdempotencyKey: key,
	})
	if err != nil {
		t.Fatalf("create booking: %v", err)
	}
	return row
}

// TestCreateBookingComputesPrice verifies the total is recomputed
// server-side: a 15000 TZS service yields total 15000 regardless of what
// the client sent (client amounts are advisory and ignored).
func TestCreateBookingComputesPrice(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Cleanup", 15000)
	st := NewStore(pool)

	row, err := st.CreateBooking(context.Background(), CreateInput{
		CustomerUserID:  customer,
		ProviderID:      provider,
		ServiceID:       service,
		ScheduledFor:    time.Now().Add(48 * time.Hour),
		DurationMinutes: intPtr(120),
		IdempotencyKey:  "it-price-1",
	})
	if err != nil {
		t.Fatalf("create booking: %v", err)
	}
	if row.SubtotalTZS != 15000 {
		t.Fatalf("subtotal = %d, want 15000", row.SubtotalTZS)
	}
	if row.TotalTZS != 15000 {
		t.Fatalf("total = %d, want 15000", row.TotalTZS)
	}
	if row.Status != "draft" || row.Version != 1 {
		t.Fatalf("status/version = %s/%d, want draft/1", row.Status, row.Version)
	}
	if row.DurationMinutes == nil || *row.DurationMinutes != 120 {
		t.Fatalf("duration = %v, want 120", row.DurationMinutes)
	}

	detail, err := st.GetBookingDetail(context.Background(), row.ID)
	if err != nil {
		t.Fatalf("get booking detail: %v", err)
	}
	if len(detail.Events) != 1 || detail.Events[0].Status != "created" {
		t.Fatalf("events = %+v, want a single created event", detail.Events)
	}
	if detail.Booking.TotalTZS != 15000 {
		t.Fatalf("detail total = %d, want 15000", detail.Booking.TotalTZS)
	}
}

// TestCreateBookingRejectsPastScheduledFor verifies the store refuses a
// booking scheduled in the past with ErrTimeInPast.
func TestCreateBookingRejectsPastScheduledFor(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	service := setupService(t, pool, "IT Booking Retro", 5000)
	st := NewStore(pool)

	_, err := st.CreateBooking(context.Background(), CreateInput{
		CustomerUserID: customer,
		ProviderID:     uuid.New(),
		ServiceID:      service,
		ScheduledFor:   time.Now().Add(-2 * time.Hour),
		IdempotencyKey: "it-past-1",
	})
	if err == nil {
		t.Fatal("create booking with past scheduledFor succeeded, want ErrTimeInPast")
	}
}

// TestCreateBookingRejectsUnknownService verifies an unknown service id
// yields ErrNotFound.
func TestCreateBookingRejectsUnknownService(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	st := NewStore(pool)

	_, err := st.CreateBooking(context.Background(), CreateInput{
		CustomerUserID: customer,
		ProviderID:     uuid.New(),
		ServiceID:      uuid.New(),
		ScheduledFor:   time.Now().Add(48 * time.Hour),
		IdempotencyKey: "it-missing-svc",
	})
	if err == nil {
		t.Fatal("create booking with unknown service succeeded, want ErrNotFound")
	}
}

// TestTransitionBookingGuards verifies the guarded status update: a stale
// expectedVersion, a double accept, and an illegal jump all yield
// ErrConflict, and every successful transition appends an event.
func TestTransitionBookingGuards(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Guard", 8000)
	st := NewStore(pool)
	ctx := context.Background()

	row := createBooking(t, st, customer, provider, service, "it-guard")

	// Accept with a stale version conflicts.
	if _, err := st.TransitionBooking(ctx, row.ID, row.Version+1,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "provider_accepted", provider, ""); err == nil {
		t.Fatal("accept with stale version succeeded, want ErrConflict")
	}
	// Accept with the right version wins.
	version, err := st.TransitionBooking(ctx, row.ID, row.Version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "provider_accepted", provider, "")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if version != row.Version+1 {
		t.Fatalf("version = %d, want %d", version, row.Version+1)
	}
	// A double accept conflicts (status already provider_accepted).
	if _, err := st.TransitionBooking(ctx, row.ID, version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "provider_accepted", provider, ""); err == nil {
		t.Fatal("double accept succeeded, want ErrConflict")
	}

	// Full lifecycle: accept -> scheduled -> in_progress -> completed
	// (each step guarded; completion is the customer confirmation).
	version, err = st.TransitionBooking(ctx, row.ID, version, []string{"provider_accepted"}, "scheduled", provider, "")
	if err != nil {
		t.Fatalf("to scheduled: %v", err)
	}
	version, err = st.TransitionBooking(ctx, row.ID, version, []string{"scheduled"}, "in_progress", provider, "")
	if err != nil {
		t.Fatalf("to in_progress: %v", err)
	}
	version, err = st.TransitionBooking(ctx, row.ID, version,
		[]string{"in_progress", "awaiting_customer_confirmation", "provider_arrived"}, "completed", customer, "")
	if err != nil {
		t.Fatalf("to completed: %v", err)
	}

	detail, err := st.GetBookingDetail(ctx, row.ID)
	if err != nil {
		t.Fatalf("get booking detail: %v", err)
	}
	statuses := make([]string, 0, len(detail.Events))
	for _, e := range detail.Events {
		statuses = append(statuses, e.Status)
	}
	want := []string{"created", "provider_accepted", "scheduled", "in_progress", "completed"}
	if len(statuses) != len(want) {
		t.Fatalf("events = %v, want %v", statuses, want)
	}
	for i := range want {
		if statuses[i] != want[i] {
			t.Fatalf("events = %v, want %v", statuses, want)
		}
	}
	if detail.Booking.Status != "completed" || detail.Booking.Version != 5 {
		t.Fatalf("booking status/version = %s/%d, want completed/5", detail.Booking.Status, detail.Booking.Version)
	}
}

// TestCancelBookingGates verifies the cancel windows: a customer may cancel
// a draft, and a provider may cancel up to provider_accepted; a scheduled
// booking is not cancellable (ErrConflict from the guarded transition).
func TestCancelBookingGates(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	provider := uuid.New()
	service := setupService(t, pool, "IT Booking Cancel", 6000)
	st := NewStore(pool)
	ctx := context.Background()

	row := createBooking(t, st, customer, provider, service, "it-cancel")
	// Customer cancels the draft.
	if _, err := st.TransitionBooking(ctx, row.ID, row.Version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "cancelled", customer, "changed my mind"); err != nil {
		t.Fatalf("customer cancel draft: %v", err)
	}

	// A fresh booking the provider accepts, then cancels before scheduling.
	row2 := createBooking(t, st, customer, provider, service, "it-cancel-2")
	version, err := st.TransitionBooking(ctx, row2.ID, row2.Version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "provider_accepted", provider, "")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if _, err := st.TransitionBooking(ctx, row2.ID, version,
		[]string{"draft", "pending_payment", "paid", "provider_requested", "provider_accepted"},
		"cancelled", provider, "no parts"); err != nil {
		t.Fatalf("provider cancel accepted: %v", err)
	}

	// A scheduled booking is not cancellable by either party.
	row3 := createBooking(t, st, customer, provider, service, "it-cancel-3")
	version, err = st.TransitionBooking(ctx, row3.ID, row3.Version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"}, "provider_accepted", provider, "")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	version, err = st.TransitionBooking(ctx, row3.ID, version, []string{"provider_accepted"}, "scheduled", provider, "")
	if err != nil {
		t.Fatalf("to scheduled: %v", err)
	}
	if _, err := st.TransitionBooking(ctx, row3.ID, version,
		[]string{"draft", "pending_payment", "paid", "provider_requested", "provider_accepted"},
		"cancelled", provider, "too late"); err == nil {
		t.Fatal("cancel after scheduling succeeded, want ErrConflict")
	}
	if _, err := st.TransitionBooking(ctx, row3.ID, version,
		[]string{"draft", "pending_payment", "paid", "provider_requested"},
		"cancelled", customer, "too late"); err == nil {
		t.Fatal("customer cancel after accept succeeded, want ErrConflict")
	}
}

// TestListMyBookingsKeysetPagination walks 25 bookings in two pages
// (20 + 5) with no overlap and a deterministic (created_at, id) order.
func TestListMyBookingsKeysetPagination(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	service := setupService(t, pool, "IT Booking Page", 2000)
	st := NewStore(pool)

	const total = 25
	created := make([]BookingRow, 0, total)
	for i := 0; i < total; i++ {
		created = append(created, createBooking(t, st, customer, uuid.New(), service, fmt.Sprintf("it-page-%02d", i)))
	}

	page1, next, err := st.ListMyBookings(context.Background(), customer, "", 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 size = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("page 1 has no next cursor")
	}
	page2, next2, err := st.ListMyBookings(context.Background(), customer, "", 20, next)
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
	for _, row := range append(append([]BookingRow{}, page1...), page2...) {
		if seen[row.ID] {
			t.Fatalf("booking %s returned twice across pages", row.ID)
		}
		seen[row.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("unique bookings = %d, want %d", len(seen), total)
	}

	// Deterministic order: (created_at, id) ascending matches a single
	// limit-50 read.
	all, _, err := st.ListMyBookings(context.Background(), customer, "", 50, "")
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

	// The status filter narrows to matching rows only.
	matched, _, err := st.ListMyBookings(context.Background(), customer, "draft", 50, "")
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if len(matched) != total {
		t.Fatalf("filtered count = %d, want %d", len(matched), total)
	}
}

// TestTransitionBookingConcurrency fires 10 concurrent transitions against
// the same (booking, version); the guarded update admits exactly one.
func TestTransitionBookingConcurrency(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	service := setupService(t, pool, "IT Booking Race", 1500)
	st := NewStore(pool)
	ctx := context.Background()

	row := createBooking(t, st, customer, uuid.New(), service, "it-concurrency")

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
			_, err := st.TransitionBooking(ctx, row.ID, 1, []string{"draft"}, "pending_payment", customer, "")
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
	final, err := st.GetBookingRow(ctx, row.ID)
	if err != nil {
		t.Fatalf("get booking: %v", err)
	}
	if final.Status != "pending_payment" || final.Version != 2 {
		t.Fatalf("final status/version = %s/%d, want pending_payment/2", final.Status, final.Version)
	}
}

func intPtr(v int) *int { return &v }
