//go:build integration

// End-to-end tests for the dine-in bounded context against real
// PostgreSQL. Run via `go test -tags integration ./internal/dinein/
// -count=1` after `go run ./cmd/migrate -up`.
package dinein

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

// newTestPool connects to DATABASE_URL and truncates only the dine-in
// bounded-context tables so tests are isolated from other agents' tables.
// catalogue_items rows created by these tests are deleted by name prefix.
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
		`TRUNCATE reservations, dine_in_orders, dine_in_tables`); err != nil {
		t.Fatalf("truncate dine-in tables: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`DELETE FROM catalogue_items WHERE name LIKE 'IT DineIn %'`); err != nil {
		t.Fatalf("delete test catalogue items: %v", err)
	}
	return pool
}

// setupCustomer inserts a users row and returns its id.
func setupCustomer(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2557%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'DineIn IT Customer') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert customer: %v", err)
	}
	return id
}

// setupTable inserts a dine-in table and returns its id.
func setupTable(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, label string, capacity int) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO dine_in_tables (merchant_id, label, capacity) VALUES ($1, $2, $3) RETURNING id`,
		merchantID, label, capacity).Scan(&id); err != nil {
		t.Fatalf("insert table: %v", err)
	}
	return id
}

// setupItem inserts an available catalogue item and returns its id.
func setupItem(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, name string, priceTZS int64) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name, price_tzs, available)
		 VALUES ($1, $2, $3, true) RETURNING id`,
		merchantID, name, priceTZS).Scan(&id); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	return id
}

// createOrder opens a dine-in order through the store for the given
// customer and returns the created row.
func createOrder(t *testing.T, st *Store, customer uuid.UUID, merchantID, tableID, itemID uuid.UUID, qty int, key string) OrderRow {
	t.Helper()
	row, err := st.CreateDineInOrder(context.Background(), CreateDineInOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchantID,
		TableID:        tableID,
		Items:          []CreateOrderItem{{CatalogueItemID: itemID, Quantity: qty}},
		IdempotencyKey: key,
	})
	if err != nil {
		t.Fatalf("create dine-in order: %v", err)
	}
	return row
}

// TestTableCRUD verifies table create, read, partial update, scoped
// listing, active toggling and merchant ownership enforcement.
func TestTableCRUD(t *testing.T) {
	pool := newTestPool(t)
	merchant := uuid.New()
	other := uuid.New()
	st := NewStore(pool)
	ctx := context.Background()

	row, err := st.CreateTable(ctx, CreateTableInput{MerchantID: merchant, Label: "Table 1", Capacity: 4})
	if err != nil {
		t.Fatalf("create table: %v", err)
	}
	if row.Label != "Table 1" || row.Capacity != 4 || !row.Active {
		t.Fatalf("created table = %+v, want label Table 1 / capacity 4 / active", row)
	}

	got, err := st.GetTable(ctx, row.ID)
	if err != nil {
		t.Fatalf("get table: %v", err)
	}
	if got.ID != row.ID || got.MerchantID != merchant {
		t.Fatalf("get table = %+v, want id %s of merchant %s", got, row.ID, merchant)
	}

	label := "Table 1 (window)"
	capacity := 6
	active := false
	updated, err := st.UpdateTable(ctx, UpdateTableInput{
		ID: row.ID, MerchantID: merchant, Label: &label, Capacity: &capacity, Active: &active,
	})
	if err != nil {
		t.Fatalf("update table: %v", err)
	}
	if updated.Label != label || updated.Capacity != capacity || updated.Active {
		t.Fatalf("updated table = %+v", updated)
	}
	// A partial update only touches the provided fields.
	reopened := true
	updated, err = st.UpdateTable(ctx, UpdateTableInput{ID: row.ID, MerchantID: merchant, Active: &reopened})
	if err != nil {
		t.Fatalf("reopen table: %v", err)
	}
	if updated.Label != label || updated.Capacity != capacity || !updated.Active {
		t.Fatalf("partial update = %+v", updated)
	}

	// Updating or toggling another merchant's table is the same not-found.
	if _, err := st.UpdateTable(ctx, UpdateTableInput{ID: row.ID, MerchantID: other, Label: &label}); err == nil {
		t.Fatal("update other merchant's table succeeded, want ErrTableNotFound")
	}
	if _, err := st.SetTableActive(ctx, row.ID, other, true); err == nil {
		t.Fatal("toggle other merchant's table succeeded, want ErrTableNotFound")
	}
	// SetTableActive round-trip.
	back, err := st.SetTableActive(ctx, row.ID, merchant, false)
	if err != nil {
		t.Fatalf("disable table: %v", err)
	}
	if back.Active {
		t.Fatal("table still active after disable")
	}

	// Listing is merchant-scoped; a zero merchant id lists everything.
	only, err := st.ListTables(ctx, merchant)
	if err != nil {
		t.Fatalf("list own tables: %v", err)
	}
	if len(only) != 1 || only[0].ID != row.ID {
		t.Fatalf("own listing = %+v, want only %s", only, row.ID)
	}
	foreign, err := st.ListTables(ctx, other)
	if err != nil {
		t.Fatalf("list other merchant's tables: %v", err)
	}
	if len(foreign) != 0 {
		t.Fatalf("other merchant listing = %+v, want empty", foreign)
	}
}

// TestCreateDineInOrderComputesPricesAndIdempotency verifies totals are
// recomputed server-side (the contract body carries no prices), a duplicate
// idempotency key replays the original order, and an open order blocks the
// table.
func TestCreateDineInOrderComputesPricesAndIdempotency(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	table := setupTable(t, pool, merchant, "Table 2", 4)
	expensive := setupItem(t, pool, merchant, "IT DineIn Pilau", 5000)
	cheap := setupItem(t, pool, merchant, "IT DineIn Mkate", 3000)
	st := NewStore(pool)
	ctx := context.Background()

	row, err := st.CreateDineInOrder(ctx, CreateDineInOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		Items: []CreateOrderItem{
			{CatalogueItemID: expensive, Quantity: 2},
			{CatalogueItemID: cheap, Quantity: 1},
		},
		IdempotencyKey: "it-dinein-price",
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if row.Status != "open" || row.TotalTZS != 13000 {
		t.Fatalf("status/total = %s/%d, want open/13000", row.Status, row.TotalTZS)
	}
	if len(row.Items) != 2 || row.Items[0].Name != "IT DineIn Pilau" || row.Items[0].UnitPriceTZS != 5000 {
		t.Fatalf("items = %+v", row.Items)
	}

	// The same idempotency key replays the original order.
	replay, err := st.CreateDineInOrder(ctx, CreateDineInOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		Items:          []CreateOrderItem{{CatalogueItemID: expensive, Quantity: 2}},
		IdempotencyKey: "it-dinein-price",
	})
	if err != nil {
		t.Fatalf("replay create order: %v", err)
	}
	if replay.ID != row.ID {
		t.Fatalf("replay id = %s, want %s", replay.ID, row.ID)
	}

	// The table hosts an open order: a second, distinct order conflicts.
	_, err = st.CreateDineInOrder(ctx, CreateDineInOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		Items:          []CreateOrderItem{{CatalogueItemID: cheap, Quantity: 1}},
		IdempotencyKey: "it-dinein-in-use",
	})
	if !errors.Is(err, ErrTableInUse) {
		t.Fatalf("second order error = %v, want ErrTableInUse", err)
	}

	// Unknown table -> ErrTableNotFound; foreign item -> ErrItemUnavailable.
	_, err = st.CreateDineInOrder(ctx, CreateDineInOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        uuid.New(),
		Items:          []CreateOrderItem{{CatalogueItemID: expensive, Quantity: 1}},
		IdempotencyKey: "it-dinein-no-table",
	})
	if !errors.Is(err, ErrTableNotFound) {
		t.Fatalf("unknown table error = %v, want ErrTableNotFound", err)
	}

	foreign := setupItem(t, pool, uuid.New(), "IT DineIn Foreign", 1000)
	table2 := setupTable(t, pool, merchant, "Table 2b", 4)
	_, err = st.CreateDineInOrder(ctx, CreateDineInOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table2,
		Items:          []CreateOrderItem{{CatalogueItemID: foreign, Quantity: 1}},
		IdempotencyKey: "it-dinein-foreign-item",
	})
	if !errors.Is(err, ErrItemUnavailable) {
		t.Fatalf("foreign item error = %v, want ErrItemUnavailable", err)
	}
}

// TestDineInPaymentTransitions walks the guarded chain
// open -> awaiting_payment -> paid -> closed: closing before payment fails,
// the open-order lookup tracks the table, and closing frees the table.
func TestDineInPaymentTransitions(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	table := setupTable(t, pool, merchant, "Table 3", 4)
	item := setupItem(t, pool, merchant, "IT DineIn Chai", 2000)
	st := NewStore(pool)
	ctx := context.Background()

	row := createOrder(t, st, customer, merchant, table, item, 1, "it-dinein-pay")

	open, err := st.GetOpenOrderForTable(ctx, table)
	if err != nil {
		t.Fatalf("get open order: %v", err)
	}
	if open == nil || open.ID != row.ID {
		t.Fatalf("open order = %+v, want %s", open, row.ID)
	}

	// Close before payment conflicts (only paid may close).
	if err := st.TransitionDineInOrder(ctx, row.ID, []string{"paid"}, "closed", merchant); err == nil {
		t.Fatal("close-before-paid succeeded, want ErrConflict")
	}

	// open -> awaiting_payment -> paid, then close.
	if err := st.TransitionDineInOrder(ctx, row.ID, []string{"open"}, "awaiting_payment", merchant); err != nil {
		t.Fatalf("to awaiting_payment: %v", err)
	}
	if err := st.TransitionDineInOrder(ctx, row.ID, []string{"awaiting_payment"}, "paid", merchant); err != nil {
		t.Fatalf("to paid: %v", err)
	}
	paid, err := st.GetDineInOrder(ctx, row.ID)
	if err != nil {
		t.Fatalf("get paid order: %v", err)
	}
	if paid.Status != "paid" || paid.PaidAt == nil {
		t.Fatalf("paid order = %+v, want status paid with paidAt", paid)
	}
	// Re-confirming a paid order conflicts.
	if err := st.TransitionDineInOrder(ctx, row.ID, []string{"open", "awaiting_payment"}, "paid", merchant); err == nil {
		t.Fatal("re-confirm paid order succeeded, want ErrConflict")
	}
	// The table is still occupied between payment and close.
	if open, err := st.GetOpenOrderForTable(ctx, table); err != nil || open == nil {
		t.Fatalf("open order while awaiting close = %+v, %v", open, err)
	}
	// Paid -> closed frees the table.
	if err := st.TransitionDineInOrder(ctx, row.ID, []string{"paid"}, "closed", merchant); err != nil {
		t.Fatalf("close: %v", err)
	}
	if open, err := st.GetOpenOrderForTable(ctx, table); err != nil || open != nil {
		t.Fatalf("open order after close = %+v, %v, want nil", open, err)
	}
	// An illegal jump conflicts.
	if err := st.TransitionDineInOrder(ctx, row.ID, []string{"open"}, "paid", merchant); err == nil {
		t.Fatal("illegal open->paid jump succeeded, want ErrConflict")
	}
}

// TestReservationCreateAndCapacity verifies reservations land as requested,
// overlapping parties are capped by table capacity, and a reservation far
// outside the overlap window does not count against the table.
func TestReservationCreateAndCapacity(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	table := setupTable(t, pool, merchant, "Table 4", 2)
	st := NewStore(pool)
	ctx := context.Background()
	when := time.Now().Add(48 * time.Hour)

	first, err := st.CreateReservation(ctx, CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		PartySize:      1,
		ReservedFor:    when,
		IdempotencyKey: "it-res-1",
	})
	if err != nil {
		t.Fatalf("first reservation: %v", err)
	}
	if first.Status != "requested" || first.PartySize != 1 {
		t.Fatalf("first reservation = %+v", first)
	}

	// The same key replays the original reservation.
	replay, err := st.CreateReservation(ctx, CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		PartySize:      5,
		ReservedFor:    when,
		IdempotencyKey: "it-res-1",
	})
	if err != nil {
		t.Fatalf("replay reservation: %v", err)
	}
	if replay.ID != first.ID {
		t.Fatalf("replay id = %s, want %s", replay.ID, first.ID)
	}

	// A party of 3 on a capacity-2 table (with 1 already seated) is full.
	_, err = st.CreateReservation(ctx, CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		PartySize:      3,
		ReservedFor:    when.Add(30 * time.Minute),
		IdempotencyKey: "it-res-full",
	})
	if !errors.Is(err, ErrTableFull) {
		t.Fatalf("oversized reservation error = %v, want ErrTableFull", err)
	}

	// A party of 1 fits (1 + 1 <= capacity 2).
	second, err := st.CreateReservation(ctx, CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		PartySize:      1,
		ReservedFor:    when.Add(30 * time.Minute),
		IdempotencyKey: "it-res-2",
	})
	if err != nil {
		t.Fatalf("second reservation: %v", err)
	}
	if second.PartySize != 1 {
		t.Fatalf("second reservation = %+v", second)
	}

	// A party of 1 six hours later does not overlap the earlier bookings.
	late, err := st.CreateReservation(ctx, CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		PartySize:      2,
		ReservedFor:    when.Add(6 * time.Hour),
		IdempotencyKey: "it-res-late",
	})
	if err != nil {
		t.Fatalf("late reservation: %v", err)
	}
	if late.PartySize != 2 {
		t.Fatalf("late reservation = %+v", late)
	}

	// Unknown table -> ErrTableNotFound.
	_, err = st.CreateReservation(ctx, CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        uuid.New(),
		PartySize:      1,
		ReservedFor:    when,
		IdempotencyKey: "it-res-no-table",
	})
	if !errors.Is(err, ErrTableNotFound) {
		t.Fatalf("unknown table error = %v, want ErrTableNotFound", err)
	}
}

// TestReservationRejectsPastTime verifies a reservation scheduled in the
// past yields ErrTimeInPast.
func TestReservationRejectsPastTime(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	table := setupTable(t, pool, merchant, "Table 5", 4)
	st := NewStore(pool)

	_, err := st.CreateReservation(context.Background(), CreateReservationInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		TableID:        table,
		PartySize:      2,
		ReservedFor:    time.Now().Add(-2 * time.Hour),
		IdempotencyKey: "it-res-past",
	})
	if !errors.Is(err, ErrTimeInPast) {
		t.Fatalf("past reservation error = %v, want ErrTimeInPast", err)
	}
}

// TestCancelReservationGates verifies requested and confirmed reservations
// cancel, while seated ones are no longer cancellable.
func TestCancelReservationGates(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	table := setupTable(t, pool, merchant, "Table 6", 4)
	st := NewStore(pool)
	ctx := context.Background()
	when := time.Now().Add(48 * time.Hour)

	mk := func(key string) ReservationRow {
		t.Helper()
		row, err := st.CreateReservation(ctx, CreateReservationInput{
			CustomerUserID: customer,
			MerchantID:     merchant,
			TableID:        table,
			PartySize:      2,
			ReservedFor:    when,
			IdempotencyKey: key,
		})
		if err != nil {
			t.Fatalf("create reservation %s: %v", key, err)
		}
		return row
	}

	// A requested reservation cancels; a second cancel is a no-op error.
	requested := mk("it-res-cancel-1")
	if err := st.CancelReservation(ctx, requested.ID, customer); err != nil {
		t.Fatalf("cancel requested: %v", err)
	}
	if err := st.CancelReservation(ctx, requested.ID, customer); err == nil {
		t.Fatal("double cancel succeeded, want ErrNotCancellable")
	}

	// A confirmed reservation also cancels.
	confirmed := mk("it-res-cancel-2")
	if _, err := pool.Exec(ctx,
		`UPDATE reservations SET status = 'confirmed' WHERE id = $1`, confirmed.ID); err != nil {
		t.Fatalf("confirm reservation: %v", err)
	}
	if err := st.CancelReservation(ctx, confirmed.ID, customer); err != nil {
		t.Fatalf("cancel confirmed: %v", err)
	}

	// A seated reservation is not cancellable.
	seated := mk("it-res-cancel-3")
	if _, err := pool.Exec(ctx,
		`UPDATE reservations SET status = 'seated' WHERE id = $1`, seated.ID); err != nil {
		t.Fatalf("seat reservation: %v", err)
	}
	if err := st.CancelReservation(ctx, seated.ID, customer); err == nil {
		t.Fatal("cancel seated succeeded, want ErrNotCancellable")
	}

	// A missing reservation is not cancellable either.
	if err := st.CancelReservation(ctx, uuid.New(), customer); err == nil {
		t.Fatal("cancel missing reservation succeeded, want ErrNotCancellable")
	}
}

// TestListMyDineInOrdersKeysetPagination walks 25 dine-in orders in two
// pages (20 + 5) with no overlap and a deterministic (created_at, id)
// order, and does the same for reservations.
func TestListMyDineInOrdersKeysetPagination(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	item := setupItem(t, pool, merchant, "IT DineIn Page", 1500)
	st := NewStore(pool)
	ctx := context.Background()

	const total = 25
	orders := make([]OrderRow, 0, total)
	for i := 0; i < total; i++ {
		table := setupTable(t, pool, merchant, fmt.Sprintf("IT Page Table %02d", i), 4)
		orders = append(orders, createOrder(t, st, customer, merchant, table, item, 1,
			fmt.Sprintf("it-page-order-%02d", i)))
	}

	page1, next, err := st.ListMyDineInOrders(ctx, customer, "", 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 size = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("page 1 has no next cursor")
	}
	page2, next2, err := st.ListMyDineInOrders(ctx, customer, "", 20, next)
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
	for _, row := range append(append([]OrderRow{}, page1...), page2...) {
		if seen[row.ID] {
			t.Fatalf("order %s returned twice across pages", row.ID)
		}
		seen[row.ID] = true
	}
	if len(seen) != total {
		t.Fatalf("unique orders = %d, want %d", len(seen), total)
	}
	for i := range page1 {
		if page1[i].ID != orders[i].ID {
			t.Fatalf("page 1 row %d = %s, want %s", i, page1[i].ID, orders[i].ID)
		}
	}
	for i := range page2 {
		if page2[i].ID != orders[20+i].ID {
			t.Fatalf("page 2 row %d = %s, want %s", i, page2[i].ID, orders[20+i].ID)
		}
	}

	// The status filter narrows to matching rows only.
	open, _, err := st.ListMyDineInOrders(ctx, customer, "open", 50, "")
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if len(open) != total {
		t.Fatalf("filtered count = %d, want %d", len(open), total)
	}

	// Reservations paginate the same way.
	when := time.Now().Add(48 * time.Hour)
	reservations := make([]ReservationRow, 0, total)
	for i := 0; i < total; i++ {
		table := setupTable(t, pool, merchant, fmt.Sprintf("IT Res Table %02d", i), 8)
		row, err := st.CreateReservation(ctx, CreateReservationInput{
			CustomerUserID: customer,
			MerchantID:     merchant,
			TableID:        table,
			PartySize:      1,
			ReservedFor:    when,
			IdempotencyKey: fmt.Sprintf("it-page-res-%02d", i),
		})
		if err != nil {
			t.Fatalf("create reservation %d: %v", i, err)
		}
		reservations = append(reservations, row)
	}
	rPage1, rNext, err := st.ListMyReservations(ctx, customer, 20, "")
	if err != nil {
		t.Fatalf("list reservations page 1: %v", err)
	}
	if len(rPage1) != 20 || rNext == "" {
		t.Fatalf("reservations page 1 = %d rows, next %q, want 20 with cursor", len(rPage1), rNext)
	}
	rPage2, rNext2, err := st.ListMyReservations(ctx, customer, 20, rNext)
	if err != nil {
		t.Fatalf("list reservations page 2: %v", err)
	}
	if len(rPage2) != 5 || rNext2 != "" {
		t.Fatalf("reservations page 2 = %d rows, next %q, want 5 with no cursor", len(rPage2), rNext2)
	}
	rSeen := make(map[uuid.UUID]bool, total)
	for _, row := range append(append([]ReservationRow{}, rPage1...), rPage2...) {
		if rSeen[row.ID] {
			t.Fatalf("reservation %s returned twice across pages", row.ID)
		}
		rSeen[row.ID] = true
	}
	if len(rSeen) != total {
		t.Fatalf("unique reservations = %d, want %d", len(rSeen), total)
	}
	for i := range rPage1 {
		if rPage1[i].ID != reservations[i].ID {
			t.Fatalf("reservations page 1 row %d = %s, want %s", i, rPage1[i].ID, reservations[i].ID)
		}
	}

	// A malformed cursor is rejected.
	if _, _, err := st.ListMyDineInOrders(ctx, customer, "", 20, "not-a-cursor"); err == nil {
		t.Fatal("malformed order cursor accepted, want ErrInvalidCursor")
	}
	if _, _, err := st.ListMyReservations(ctx, customer, 20, "not-a-cursor"); err == nil {
		t.Fatal("malformed reservation cursor accepted, want ErrInvalidCursor")
	}
}

// TestReservationConcurrency fires 10 concurrent reservations of party 1 at
// the same time on a capacity-1 table; the FOR UPDATE lock serializes them
// and exactly one wins.
func TestReservationConcurrency(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	table := setupTable(t, pool, merchant, "Table 7", 1)
	st := NewStore(pool)
	ctx := context.Background()
	when := time.Now().Add(48 * time.Hour)

	const workers = 10
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
		others  int
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := st.CreateReservation(ctx, CreateReservationInput{
				CustomerUserID: customer,
				MerchantID:     merchant,
				TableID:        table,
				PartySize:      1,
				ReservedFor:    when,
				IdempotencyKey: fmt.Sprintf("it-race-%02d", i),
			})
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				winners++
			case errors.Is(err, ErrTableFull):
				others++
			default:
				t.Errorf("unexpected reservation error: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if winners != 1 {
		t.Fatalf("winners = %d, want exactly 1", winners)
	}
	if winners+others != workers {
		t.Fatalf("outcomes = %d winners + %d full, want %d total", winners, others, workers)
	}

	// Verify exactly one committed row for this table at that time.
	var count int
	if err := pool.QueryRow(ctx,
		`SELECT COUNT(*) FROM reservations
		 WHERE table_id = $1 AND status = 'requested' AND reserved_for BETWEEN $2 AND $3`,
		table, when.Add(-time.Minute), when.Add(time.Minute)).Scan(&count); err != nil {
		t.Fatalf("count reservations: %v", err)
	}
	if count != 1 {
		t.Fatalf("committed reservations = %d, want 1", count)
	}
}
