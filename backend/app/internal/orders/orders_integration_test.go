//go:build integration

// End-to-end tests for the orders bounded context against real PostgreSQL.
// Run via `go test -tags integration ./internal/orders/ -count=1` after
// `go run ./cmd/migrate -up`.
package orders

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

// newTestPool connects to DATABASE_URL and truncates only the orders
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
		`TRUNCATE order_events, order_items, orders, catalogue_items, product_categories, order_assignments CASCADE`); err != nil {
		t.Fatalf("truncate orders tables: %v", err)
	}
	return pool
}

// setupCustomer inserts a users row and returns its id.
func setupCustomer(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2557%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'Orders IT Customer') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert customer: %v", err)
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

// createOrder inserts an order through the store for the given customer and
// returns the created row.
func createOrder(t *testing.T, st *Store, customer uuid.UUID, itemIDs []uuid.UUID, key string) OrderRow {
	t.Helper()
	items := make([]CreateOrderItem, 0, len(itemIDs))
	for _, id := range itemIDs {
		items = append(items, CreateOrderItem{CatalogueItemID: id, Quantity: 1})
	}
	row, err := st.CreateOrder(context.Background(), CreateOrderInput{
		CustomerUserID: customer,
		MerchantID:     uuid.New(),
		Items:          items,
		IdempotencyKey: key,
		Source:         "app",
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	return row
}

// TestCreateOrderComputesPrices verifies totals are recomputed server-side:
// 5000 x2 + 3000 x1 -> subtotal 13000, total 13000 + 2000 + 1000 = 16000.
func TestCreateOrderComputesPrices(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	merchant := uuid.New()
	expensive := setupItem(t, pool, merchant, "Pilau", 5000)
	cheap := setupItem(t, pool, merchant, "Mkate", 3000)
	st := NewStore(pool)

	row, err := st.CreateOrder(context.Background(), CreateOrderInput{
		CustomerUserID: customer,
		MerchantID:     merchant,
		Items: []CreateOrderItem{
			{CatalogueItemID: expensive, Quantity: 2},
			{CatalogueItemID: cheap, Quantity: 1},
		},
		IdempotencyKey: "it-price-1",
		Source:         "app",
	})
	if err != nil {
		t.Fatalf("create order: %v", err)
	}
	if row.SubtotalTZS != 13000 {
		t.Fatalf("subtotal = %d, want 13000", row.SubtotalTZS)
	}
	if row.DeliveryFeeTZS != DeliveryFeeTZS || row.PlatformFeeTZS != PlatformFeeTZS {
		t.Fatalf("fees = %d/%d, want %d/%d", row.DeliveryFeeTZS, row.PlatformFeeTZS, DeliveryFeeTZS, PlatformFeeTZS)
	}
	if row.TotalTZS != 16000 {
		t.Fatalf("total = %d, want 16000", row.TotalTZS)
	}
	if row.Status != "draft" || row.Version != 1 {
		t.Fatalf("status/version = %s/%d, want draft/1", row.Status, row.Version)
	}
	if row.No == "" {
		t.Fatal("order number is empty")
	}

	detail, err := st.GetOrderDetail(context.Background(), row.ID)
	if err != nil {
		t.Fatalf("get order detail: %v", err)
	}
	if len(detail.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(detail.Items))
	}
	byName := make(map[string]OrderItemRow, len(detail.Items))
	for _, it := range detail.Items {
		byName[it.Name] = it
	}
	pilau, ok := byName["Pilau"]
	if !ok || pilau.UnitPriceTZS != 5000 || pilau.Quantity != 2 {
		t.Fatalf("unexpected Pilau line: %+v", detail.Items)
	}
	mkate, ok := byName["Mkate"]
	if !ok || mkate.UnitPriceTZS != 3000 || mkate.Quantity != 1 {
		t.Fatalf("unexpected Mkate line: %+v", detail.Items)
	}
	if len(detail.Events) != 1 || detail.Events[0].Status != "created" {
		t.Fatalf("events = %+v, want a single created event", detail.Events)
	}
}

// TestCreateOrderDuplicateIdempotencyKey verifies the unique
// (customer_user_id, idempotency_key) constraint surfaces as an error on a
// second insert with the same customer and key.
func TestCreateOrderDuplicateIdempotencyKey(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	item := setupItem(t, pool, uuid.New(), "Chapati", 1000)
	st := NewStore(pool)

	if _, err := st.CreateOrder(context.Background(), CreateOrderInput{
		CustomerUserID: customer,
		MerchantID:     uuid.New(),
		Items:          []CreateOrderItem{{CatalogueItemID: item, Quantity: 1}},
		IdempotencyKey: "it-dupe-key",
		Source:         "app",
	}); err != nil {
		t.Fatalf("first create order: %v", err)
	}
	if _, err := st.CreateOrder(context.Background(), CreateOrderInput{
		CustomerUserID: customer,
		MerchantID:     uuid.New(),
		Items:          []CreateOrderItem{{CatalogueItemID: item, Quantity: 1}},
		IdempotencyKey: "it-dupe-key",
		Source:         "app",
	}); err == nil {
		t.Fatal("second create with the same customer + idempotency key succeeded, want error")
	}

	// The same key under a different customer is a distinct order.
	other := setupCustomer(t, pool)
	if _, err := st.CreateOrder(context.Background(), CreateOrderInput{
		CustomerUserID: other,
		MerchantID:     uuid.New(),
		Items:          []CreateOrderItem{{CatalogueItemID: item, Quantity: 1}},
		IdempotencyKey: "it-dupe-key",
		Source:         "app",
	}); err != nil {
		t.Fatalf("same key under another customer: %v", err)
	}
}

// TestListOrdersKeysetPagination walks 25 orders in two pages (20 + 5)
// with no overlap and a deterministic (created_at, id) order.
func TestListOrdersKeysetPagination(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	item := setupItem(t, pool, uuid.New(), "Wali", 2000)
	st := NewStore(pool)

	const total = 25
	created := make([]OrderRow, 0, total)
	for i := 0; i < total; i++ {
		created = append(created, createOrder(t, st, customer, []uuid.UUID{item}, fmt.Sprintf("it-page-%02d", i)))
	}

	page1, next, err := st.ListOrders(context.Background(), customer, "", 20, "")
	if err != nil {
		t.Fatalf("list page 1: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("page 1 size = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("page 1 has no next cursor")
	}
	page2, next2, err := st.ListOrders(context.Background(), customer, "", 20, next)
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

	// Deterministic order: (created_at, id) ascending matches a single
	// limit-50 read.
	all, _, err := st.ListOrders(context.Background(), customer, "", 50, "")
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
}

// TestTransitionOrderGuards verifies the guarded status update: a stale
// expectedVersion, a double accept, and a state jump all yield ErrConflict,
// and every successful transition appends an event.
func TestTransitionOrderGuards(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	item := setupItem(t, pool, uuid.New(), "Supa", 4000)
	st := NewStore(pool)
	ctx := context.Background()

	row := createOrder(t, st, customer, []uuid.UUID{item}, "it-guard")

	// Accept with a stale version conflicts.
	if _, err := st.TransitionOrder(ctx, row.ID, row.Version+1, []string{"draft", "pending_payment", "paid"}, "merchant_accepted", customer, ""); err == nil {
		t.Fatal("accept with stale version succeeded, want ErrConflict")
	}
	// Accept with the right version wins.
	version, err := st.TransitionOrder(ctx, row.ID, row.Version, []string{"draft", "pending_payment", "paid"}, "merchant_accepted", customer, "")
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	if version != row.Version+1 {
		t.Fatalf("version = %d, want %d", version, row.Version+1)
	}
	// A double accept conflicts (status already merchant_accepted).
	if _, err := st.TransitionOrder(ctx, row.ID, version, []string{"draft", "pending_payment", "paid"}, "merchant_accepted", customer, ""); err == nil {
		t.Fatal("double accept succeeded, want ErrConflict")
	}
	// Advance to preparing, then attempt an illegal jump preparing ->
	// completed in one step (from-status guard fails).
	version, err = st.TransitionOrder(ctx, row.ID, version, []string{"merchant_accepted"}, "preparing", customer, "")
	if err != nil {
		t.Fatalf("to preparing: %v", err)
	}
	if _, err := st.TransitionOrder(ctx, row.ID, version, []string{"merchant_accepted"}, "completed", customer, ""); err == nil {
		t.Fatal("jump to completed from preparing succeeded, want ErrConflict")
	}

	detail, err := st.GetOrderDetail(ctx, row.ID)
	if err != nil {
		t.Fatalf("get order detail: %v", err)
	}
	statuses := make([]string, 0, len(detail.Events))
	for _, e := range detail.Events {
		statuses = append(statuses, e.Status)
	}
	want := []string{"created", "merchant_accepted", "preparing"}
	if len(statuses) != len(want) {
		t.Fatalf("events = %v, want %v", statuses, want)
	}
	for i := range want {
		if statuses[i] != want[i] {
			t.Fatalf("events = %v, want %v", statuses, want)
		}
	}
	if detail.Order.Status != "preparing" || detail.Order.Version != 3 {
		t.Fatalf("order status/version = %s/%d, want preparing/3", detail.Order.Status, detail.Order.Version)
	}
}

// TestTransitionOrderConcurrency fires 10 concurrent transitions against the
// same (order, version); the guarded update admits exactly one.
func TestTransitionOrderConcurrency(t *testing.T) {
	pool := newTestPool(t)
	customer := setupCustomer(t, pool)
	item := setupItem(t, pool, uuid.New(), "Kitowee", 1500)
	st := NewStore(pool)
	ctx := context.Background()

	row := createOrder(t, st, customer, []uuid.UUID{item}, "it-concurrency")

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
			_, err := st.TransitionOrder(ctx, row.ID, 1, []string{"draft"}, "pending_payment", customer, "")
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
	final, err := st.GetOrderRow(ctx, row.ID)
	if err != nil {
		t.Fatalf("get order: %v", err)
	}
	if final.Status != "pending_payment" || final.Version != 2 {
		t.Fatalf("final status/version = %s/%d, want pending_payment/2", final.Status, final.Version)
	}
}
