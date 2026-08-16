//go:build integration

// Integration tests for the warehouse stock and fulfillment lane (migration
// 00051) against real PostgreSQL.
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/logistics/ -count=1
//
// Every run truncates ONLY warehouse_stock at setup so the suite is isolated
// from other agents' tables; the warehouses, users, orders, order_items,
// catalogue_items and shipments rows this suite needs are its own, created
// and removed per test (the other suites truncate their own tables in the
// same package run).
package logistics

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// newWarehouseStockTestPool connects to DATABASE_URL and truncates only the
// warehouse_stock table (migration 00051).
func newWarehouseStockTestPool(t *testing.T) *pgxpool.Pool {
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
	if _, err := pool.Exec(context.Background(), `TRUNCATE warehouse_stock CASCADE`); err != nil {
		t.Fatalf("truncate warehouse_stock: %v", err)
	}
	return pool
}

// warehouseStockFixture bundles the pool and the store for the suite.
type warehouseStockFixture struct {
	pool *pgxpool.Pool
	st   *WarehouseStore
}

func newWarehouseStockFixture(t *testing.T) *warehouseStockFixture {
	t.Helper()
	pool := newWarehouseStockTestPool(t)
	return &warehouseStockFixture{pool: pool, st: NewWarehouseStore(pool)}
}

// ownWarehouse creates this suite's own warehouses row (the extra suite
// truncates the warehouses table in another file's tests, so rows are never
// assumed to survive) and removes it on cleanup.
func (fx *warehouseStockFixture) ownWarehouse(t *testing.T, status string) (uuid.UUID, string) {
	t.Helper()
	name := "WH-Test-" + uuid.NewString()[:8]
	var id uuid.UUID
	if err := fx.pool.QueryRow(context.Background(),
		`INSERT INTO warehouses (name, status) VALUES ($1, $2) RETURNING id`,
		name, status).Scan(&id); err != nil {
		t.Fatalf("insert warehouse: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(context.Background(), `DELETE FROM warehouses WHERE id = $1`, id)
	})
	return id, name
}

// ownCatalogueItem creates this suite's own catalogue_items row and removes
// it on cleanup.
func (fx *warehouseStockFixture) ownCatalogueItem(t *testing.T) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := fx.pool.QueryRow(context.Background(),
		`INSERT INTO catalogue_items (merchant_id, name) VALUES ($1, $2) RETURNING id`,
		uuid.New(), "Stock Item "+uuid.NewString()[:8]).Scan(&id); err != nil {
		t.Fatalf("insert catalogue item: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(context.Background(), `DELETE FROM catalogue_items WHERE id = $1`, id)
	})
	return id
}

// ownOrder creates this suite's own users/orders/order_items rows for the
// given catalogue item and quantity and removes them on cleanup (orders
// cascade order_items; the suite's own shipment rows for the order are
// removed too — the core suite truncates shipments in another file's tests).
func (fx *warehouseStockFixture) ownOrder(t *testing.T, itemID uuid.UUID, qty int) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	var userID uuid.UUID
	if err := fx.pool.QueryRow(ctx,
		`INSERT INTO users (phone, full_name) VALUES ($1, 'warehouse stock test') RETURNING id`,
		"+2557"+uuid.NewString()[:8]).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, userID)
	})
	var orderID uuid.UUID
	if err := fx.pool.QueryRow(ctx,
		`INSERT INTO orders (customer_user_id, merchant_id, status) VALUES ($1, $2, 'paid') RETURNING id`,
		userID, uuid.New()).Scan(&orderID); err != nil {
		t.Fatalf("insert order: %v", err)
	}
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(ctx, `DELETE FROM orders WHERE id = $1`, orderID)
	})
	t.Cleanup(func() {
		_, _ = fx.pool.Exec(ctx, `DELETE FROM shipments WHERE order_id = $1`, orderID)
	})
	if _, err := fx.pool.Exec(ctx,
		`INSERT INTO order_items (order_id, catalogue_item_id, name_snapshot, quantity, unit_price_tzs)
		 VALUES ($1, $2, 'Warehouse stock item', $3, 5000)`,
		orderID, itemID, qty); err != nil {
		t.Fatalf("insert order item: %v", err)
	}
	return orderID
}

// shipmentCount reports how many shipments exist for an order.
func (fx *warehouseStockFixture) shipmentCount(t *testing.T, orderID uuid.UUID) int {
	t.Helper()
	var count int
	if err := fx.pool.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM shipments WHERE order_id = $1`, orderID).Scan(&count); err != nil {
		t.Fatalf("count shipments: %v", err)
	}
	return count
}

// TestWarehouseStockAdjustUpDown covers the upsert (fresh line takes the
// delta as quantity) and a follow-up negative delta.
func TestWarehouseStockAdjustUpDown(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, _ := fx.ownWarehouse(t, WarehouseStatusActive)
	item := fx.ownCatalogueItem(t)

	qty, err := fx.st.AdjustStock(ctx, wh, item, 10)
	if err != nil || qty != 10 {
		t.Fatalf("adjust +10 = %d, %v", qty, err)
	}
	qty, err = fx.st.AdjustStock(ctx, wh, item, -4)
	if err != nil || qty != 6 {
		t.Fatalf("adjust -4 = %d, %v", qty, err)
	}
	row, err := fx.st.GetStock(ctx, wh, item)
	if err != nil || row.Quantity != 6 || row.Reserved != 0 {
		t.Fatalf("stock row = %+v, %v", row, err)
	}
}

// TestWarehouseStockAdjustNegative covers the negative-balance guard: both
// on an existing line and as the very first delta of a fresh line, with no
// write on failure.
func TestWarehouseStockAdjustNegative(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, _ := fx.ownWarehouse(t, WarehouseStatusActive)
	item := fx.ownCatalogueItem(t)

	if _, err := fx.st.AdjustStock(ctx, wh, item, -1); !errors.Is(err, ErrNegativeStock) {
		t.Fatalf("negative first delta = %v, want ErrNegativeStock", err)
	}
	if _, err := fx.st.GetStock(ctx, wh, item); !errors.Is(err, ErrStockNotFound) {
		t.Fatalf("fresh negative delta wrote a line = %v, want ErrStockNotFound", err)
	}
	if _, err := fx.st.AdjustStock(ctx, wh, item, 5); err != nil {
		t.Fatalf("adjust +5: %v", err)
	}
	if _, err := fx.st.AdjustStock(ctx, wh, item, -10); !errors.Is(err, ErrNegativeStock) {
		t.Fatalf("negative overshoot = %v, want ErrNegativeStock", err)
	}
	row, err := fx.st.GetStock(ctx, wh, item)
	if err != nil || row.Quantity != 5 {
		t.Fatalf("stock after failed adjust = %+v, %v (want unchanged 5)", row, err)
	}
}

// TestWarehouseStockAdjustGuards covers the warehouse-state guards:
// ErrWarehouseNotFound for an unknown warehouse and
// ErrWarehouseOutOfService for a non-active one.
func TestWarehouseStockAdjustGuards(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	item := fx.ownCatalogueItem(t)

	if _, err := fx.st.AdjustStock(ctx, uuid.New(), item, 1); !errors.Is(err, ErrWarehouseNotFound) {
		t.Fatalf("adjust at unknown warehouse = %v, want ErrWarehouseNotFound", err)
	}
	closed, _ := fx.ownWarehouse(t, WarehouseStatusOutOfService)
	if _, err := fx.st.AdjustStock(ctx, closed, item, 1); !errors.Is(err, ErrWarehouseOutOfService) {
		t.Fatalf("adjust at out-of-service warehouse = %v, want ErrWarehouseOutOfService", err)
	}
	if _, _, err := fx.st.ListStock(ctx, uuid.New(), 20, ""); !errors.Is(err, ErrWarehouseNotFound) {
		t.Fatalf("list stock at unknown warehouse = %v, want ErrWarehouseNotFound", err)
	}
}

// TestWarehouseFulfillInsufficient covers the available-stock guard: a
// shortage rolls the whole transaction back (no stock movement, no shipment).
func TestWarehouseFulfillInsufficient(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, _ := fx.ownWarehouse(t, WarehouseStatusActive)
	item := fx.ownCatalogueItem(t)
	if _, err := fx.st.AdjustStock(ctx, wh, item, 5); err != nil {
		t.Fatalf("adjust stock: %v", err)
	}
	orderID := fx.ownOrder(t, item, 10)

	if err := fx.st.Fulfill(ctx, wh, orderID); !errors.Is(err, ErrStockUnavailable) {
		t.Fatalf("fulfill beyond stock = %v, want ErrStockUnavailable", err)
	}
	row, err := fx.st.GetStock(ctx, wh, item)
	if err != nil || row.Quantity != 5 || row.Reserved != 0 {
		t.Fatalf("stock after failed fulfill = %+v, %v (want quantity 5, reserved 0)", row, err)
	}
	if count := fx.shipmentCount(t, orderID); count != 0 {
		t.Fatalf("shipments after failed fulfill = %d, want 0", count)
	}
}

// TestWarehouseFulfillSufficient covers the happy path: quantity drops,
// reserved rises, a pending shipment is created from the warehouse (origin
// hub NULL, warehouse name as current_location, 'warehouse fulfill' on the
// created event) and a second fulfill of the same order is rejected.
func TestWarehouseFulfillSufficient(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, whName := fx.ownWarehouse(t, WarehouseStatusActive)
	item := fx.ownCatalogueItem(t)
	if _, err := fx.st.AdjustStock(ctx, wh, item, 10); err != nil {
		t.Fatalf("adjust stock: %v", err)
	}
	orderID := fx.ownOrder(t, item, 4)

	if err := fx.st.Fulfill(ctx, wh, orderID); err != nil {
		t.Fatalf("fulfill: %v", err)
	}
	row, err := fx.st.GetStock(ctx, wh, item)
	if err != nil || row.Quantity != 6 || row.Reserved != 4 {
		t.Fatalf("stock after fulfill = %+v, %v (want quantity 6, reserved 4)", row, err)
	}
	var (
		shipmentID      uuid.UUID
		status          string
		originHubID     *uuid.UUID
		currentLocation *string
		waybill         string
	)
	if err := fx.pool.QueryRow(ctx,
		`SELECT id, status, origin_hub_id, current_location, waybill_number
		 FROM shipments WHERE order_id = $1`, orderID).Scan(&shipmentID, &status, &originHubID, &currentLocation, &waybill); err != nil {
		t.Fatalf("load shipment: %v", err)
	}
	if status != StatusPending || originHubID != nil || currentLocation == nil || *currentLocation != whName {
		t.Fatalf("shipment = status %q, origin %v, location %v; want pending, NULL, %q", status, originHubID, currentLocation, whName)
	}
	if len(waybill) != len("WB-")+8 {
		t.Fatalf("waybill = %q, want WB-<8 hex>", waybill)
	}
	var note string
	if err := fx.pool.QueryRow(ctx,
		`SELECT note FROM shipment_events WHERE shipment_id = $1 AND status = 'created'`,
		shipmentID).Scan(&note); err != nil || note != "warehouse fulfill" {
		t.Fatalf("created event note = %q, %v (want 'warehouse fulfill')", note, err)
	}

	if err := fx.st.Fulfill(ctx, wh, orderID); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second fulfill = %v, want ErrAlreadyExists", err)
	}
	if count := fx.shipmentCount(t, orderID); count != 1 {
		t.Fatalf("shipments after double fulfill = %d, want 1", count)
	}
}

// TestWarehouseFulfillGuards covers the fulfill preconditions: unknown
// warehouse, missing order, out-of-service warehouse and an item the
// warehouse does not stock.
func TestWarehouseFulfillGuards(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, _ := fx.ownWarehouse(t, WarehouseStatusActive)
	item := fx.ownCatalogueItem(t)
	if _, err := fx.st.AdjustStock(ctx, wh, item, 5); err != nil {
		t.Fatalf("adjust stock: %v", err)
	}

	if err := fx.st.Fulfill(ctx, uuid.New(), uuid.New()); !errors.Is(err, ErrWarehouseNotFound) {
		t.Fatalf("fulfill at unknown warehouse = %v, want ErrWarehouseNotFound", err)
	}
	if err := fx.st.Fulfill(ctx, wh, uuid.New()); !errors.Is(err, ErrOrderNotFound) {
		t.Fatalf("fulfill missing order = %v, want ErrOrderNotFound", err)
	}
	closed, _ := fx.ownWarehouse(t, WarehouseStatusOutOfService)
	orderAtClosed := fx.ownOrder(t, item, 1)
	if err := fx.st.Fulfill(ctx, closed, orderAtClosed); !errors.Is(err, ErrWarehouseOutOfService) {
		t.Fatalf("fulfill at out-of-service warehouse = %v, want ErrWarehouseOutOfService", err)
	}
	unstocked := fx.ownCatalogueItem(t)
	orderWithUnstocked := fx.ownOrder(t, unstocked, 1)
	if err := fx.st.Fulfill(ctx, wh, orderWithUnstocked); !errors.Is(err, ErrStockUnavailable) {
		t.Fatalf("fulfill with unstocked item = %v, want ErrStockUnavailable", err)
	}
}

// TestWarehouseStockConcurrentAdjusts covers row-level locking: 10
// concurrent +5 adjusts serialize on the line and land at exactly 50.
func TestWarehouseStockConcurrentAdjusts(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, _ := fx.ownWarehouse(t, WarehouseStatusActive)
	item := fx.ownCatalogueItem(t)

	const goroutines = 10
	var wg sync.WaitGroup
	errs := make(chan error, goroutines)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := fx.st.AdjustStock(ctx, wh, item, 5); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent adjust: %v", err)
	}
	row, err := fx.st.GetStock(ctx, wh, item)
	if err != nil || row.Quantity != 50 {
		t.Fatalf("stock after 10 concurrent +5 = %+v, %v (want 50)", row, err)
	}
}

// TestWarehouseStockPagination25 covers keyset pagination across two pages
// (20 + 5) with a cursor.
func TestWarehouseStockPagination25(t *testing.T) {
	fx := newWarehouseStockFixture(t)
	ctx := context.Background()
	wh, _ := fx.ownWarehouse(t, WarehouseStatusActive)
	for i := 0; i < 25; i++ {
		item := fx.ownCatalogueItem(t)
		if _, err := fx.st.AdjustStock(ctx, wh, item, 1); err != nil {
			t.Fatalf("adjust item %d: %v", i, err)
		}
	}

	page1, next, err := fx.st.ListStock(ctx, wh, 20, "")
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(page1) != 20 {
		t.Fatalf("first page = %d, want 20", len(page1))
	}
	if next == "" {
		t.Fatal("missing next cursor after first page")
	}
	page2, next2, err := fx.st.ListStock(ctx, wh, 5, next)
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(page2) != 5 {
		t.Fatalf("second page = %d, want 5", len(page2))
	}
	if next2 != "" {
		t.Fatalf("second next = %q, want empty", next2)
	}
	if page1[19].ID == page2[0].ID {
		t.Fatal("pages overlap")
	}
	if _, _, err := fx.st.ListStock(ctx, wh, 20, "garbage-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("bad cursor = %v, want ErrInvalidCursor", err)
	}
}
