//go:build integration

// Integration tests for the inventory & procurement bounded context against
// real PostgreSQL.
//
//	cd app && go run ./cmd/migrate -up && go test -tags integration ./internal/inventory/ -count=1
//
// Every run truncates ONLY this context's tables (inventory_items,
// inventory_adjustments, inventory_alerts, inventory_sync_config, suppliers,
// purchase_orders, purchase_order_items, supplier_returns) so the suite is
// isolated from other bounded contexts' tables and other agents' data.
package inventory

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

// inventoryTables is every table owned by this bounded context. Migration
// 00023 must be applied before the suite runs.
const inventoryTables = `inventory_sync_config, supplier_returns, purchase_order_items,
	purchase_orders, suppliers, inventory_alerts, inventory_adjustments, inventory_items`

// newTestPool connects to DATABASE_URL and truncates only the inventory
// tables so tests are isolated from other agents' tables.
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
	if _, err := pool.Exec(context.Background(), `TRUNCATE `+inventoryTables); err != nil {
		t.Fatalf("truncate inventory tables: %v", err)
	}
	return pool
}

// setupUser inserts a users row and returns its id.
func setupUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	phone := fmt.Sprintf("+2555%09d", time.Now().UnixNano()%1_000_000_000)
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (phone, full_name) VALUES ($1, 'Inventory IT User') RETURNING id`,
		phone).Scan(&id); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	return id
}

// createItem inserts an item with the given starting quantity.
func createItem(t *testing.T, st *Store, merchant uuid.UUID, name, sku string, qty, threshold int) Item {
	t.Helper()
	it, err := st.CreateItem(context.Background(), merchant, name, sku, threshold, "pcs", 500)
	if err != nil {
		t.Fatalf("create item %s: %v", name, err)
	}
	if _, err := st.Adjust(context.Background(), merchant, it.ID, qty, "initial stock"); err != nil {
		t.Fatalf("seed quantity for %s: %v", name, err)
	}
	return it
}

// TestItemLifecycle covers create -> list -> get with the server-assigned
// fields (id, zero quantity, threshold) intact.
func TestItemLifecycle(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	it, err := st.CreateItem(ctx, merchant, "Sugar", "SUG-1", 5, "kg", 3200)
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	if it.ID == uuid.Nil || it.Quantity != 0 || it.LowStockThreshold != 5 {
		t.Fatalf("created item = %+v, want id + qty 0 + threshold 5", it)
	}
	if _, err := st.CreateItem(ctx, merchant, "Flour", "FLR-1", 10, "kg", 2500); err != nil {
		t.Fatalf("create second item: %v", err)
	}

	items, next, err := st.ListItems(ctx, merchant, false, 50, "")
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("listed items = %d, want 2", len(items))
	}
	if next != "" {
		t.Fatalf("next cursor = %q, want empty", next)
	}
	got, err := st.GetItem(ctx, merchant, it.ID)
	if err != nil {
		t.Fatalf("get item: %v", err)
	}
	if got.Name != "Sugar" || got.SKU != "SUG-1" || got.CostTZS != 3200 {
		t.Fatalf("get item = %+v", got)
	}
	// Another merchant never sees this item (existence is not leaked).
	other := setupUser(t, pool)
	if _, err := st.GetItem(ctx, other, it.ID); !errors.Is(err, ErrItemNotFound) {
		t.Fatalf("cross-merchant get = %v, want ErrItemNotFound", err)
	}
}

// TestAdjustStock covers positive and negative deltas plus the append-only
// adjustment log.
func TestAdjustStock(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	it := createItem(t, st, merchant, "Oil", "OIL-1", 10, 5)

	newQty, err := st.Adjust(ctx, merchant, it.ID, 5, "delivery received")
	if err != nil {
		t.Fatalf("adjust +5: %v", err)
	}
	if newQty != 15 {
		t.Fatalf("new quantity = %d, want 15", newQty)
	}
	newQty, err = st.Adjust(ctx, merchant, it.ID, -7, "spoilage")
	if err != nil {
		t.Fatalf("adjust -7: %v", err)
	}
	if newQty != 8 {
		t.Fatalf("new quantity = %d, want 8", newQty)
	}

	adjustments, _, err := st.ListAdjustments(ctx, merchant, 50, "")
	if err != nil {
		t.Fatalf("list adjustments: %v", err)
	}
	if len(adjustments) != 3 {
		t.Fatalf("adjustments = %d, want 3 (seed + 2)", len(adjustments))
	}
	if adjustments[0].Delta != -7 || adjustments[0].Reason != "spoilage" {
		t.Fatalf("latest adjustment = %+v, want delta -7 spoilage", adjustments[0])
	}
}

// TestAdjustNegativeRejected: an adjustment that would drive stock below
// zero yields ErrNegativeStock and writes nothing.
func TestAdjustNegativeRejected(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	it := createItem(t, st, merchant, "Salt", "SALT-1", 3, 2)

	if _, err := st.Adjust(ctx, merchant, it.ID, -4, "damaged"); !errors.Is(err, ErrNegativeStock) {
		t.Fatalf("adjust -4 on qty 3 = %v, want ErrNegativeStock", err)
	}
	got, err := st.GetItem(ctx, merchant, it.ID)
	if err != nil {
		t.Fatalf("get item: %v", err)
	}
	if got.Quantity != 3 {
		t.Fatalf("quantity after rejected adjust = %d, want 3", got.Quantity)
	}
	var adjustmentCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM inventory_adjustments WHERE item_id = $1`, it.ID).Scan(&adjustmentCount); err != nil {
		t.Fatalf("adjustment count query: %v", err)
	}
	if adjustmentCount != 1 {
		t.Fatalf("adjustment rows = %d, want 1 (only the seed)", adjustmentCount)
	}
}

// TestAdjustReasonRequired: an empty reason is rejected with
// ErrReasonRequired and no adjustment row is written.
func TestAdjustReasonRequired(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	it := createItem(t, st, merchant, "Rice", "RICE-1", 5, 3)

	if _, err := st.Adjust(ctx, merchant, it.ID, -1, "  "); !errors.Is(err, ErrReasonRequired) {
		t.Fatalf("adjust with blank reason = %v, want ErrReasonRequired", err)
	}
	var adjustmentCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM inventory_adjustments WHERE item_id = $1`, it.ID).Scan(&adjustmentCount); err != nil {
		t.Fatalf("adjustment count query: %v", err)
	}
	if adjustmentCount != 1 {
		t.Fatalf("adjustment rows = %d, want 1 (only the seed)", adjustmentCount)
	}
}

// TestLowStockAlertAutoCreated: adjusting to at or below the threshold
// creates an unresolved alert; resolving it hides it from the listing.
func TestLowStockAlertAutoCreated(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	it, err := st.CreateItem(ctx, merchant, "Milk", "MILK-1", 5, "L", 500)
	if err != nil {
		t.Fatalf("create item: %v", err)
	}
	if _, err := st.Adjust(ctx, merchant, it.ID, 10, "restock"); err != nil {
		t.Fatalf("adjust above threshold: %v", err)
	}
	if _, err := st.Adjust(ctx, merchant, it.ID, -6, "sold"); err != nil {
		t.Fatalf("adjust below threshold: %v", err)
	}
	alerts, _, err := st.ListAlerts(ctx, merchant, 50, "")
	if err != nil {
		t.Fatalf("list alerts: %v", err)
	}
	if len(alerts) != 1 {
		t.Fatalf("alerts = %d, want 1", len(alerts))
	}
	if alerts[0].ItemID != it.ID || alerts[0].Type != "low_stock" || alerts[0].Resolved {
		t.Fatalf("alert = %+v, want low_stock unresolved for item", alerts[0])
	}
	alertID := alerts[0].ID

	if err := st.ResolveAlert(ctx, alertID); err != nil {
		t.Fatalf("resolve alert: %v", err)
	}
	alerts, _, err = st.ListAlerts(ctx, merchant, 50, "")
	if err != nil {
		t.Fatalf("list alerts after resolve: %v", err)
	}
	if len(alerts) != 0 {
		t.Fatalf("alerts after resolve = %d, want 0", len(alerts))
	}
	// Resolving an already-resolved alert is reported as not found.
	if err := st.ResolveAlert(ctx, alertID); !errors.Is(err, ErrAlertNotFound) {
		t.Fatalf("re-resolve = %v, want ErrAlertNotFound", err)
	}
}

// TestPurchaseOrderLifecycle is the full PO journey: create (total computed
// server-side) -> send -> partial receive (stock updated, status
// partially_received) -> final receive (received) -> over-receive rejected
// -> cancel after received rejected.
func TestPurchaseOrderLifecycle(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	supplier, err := st.CreateSupplier(ctx, merchant, "Dar Wholesale", "+255700000000", "active")
	if err != nil {
		t.Fatalf("create supplier: %v", err)
	}
	oil := createItem(t, st, merchant, "Oil", "OIL-2", 0, 5)
	salt := createItem(t, st, merchant, "Salt", "SALT-2", 0, 5)

	poID, err := st.CreatePO(ctx, merchant, supplier.ID, []POItemInput{
		{ItemID: oil.ID, Quantity: 10, UnitCostTZS: 500},
		{ItemID: salt.ID, Quantity: 4, UnitCostTZS: 250},
	}, "weekly order")
	if err != nil {
		t.Fatalf("create po: %v", err)
	}
	po, err := st.GetPO(ctx, merchant, poID)
	if err != nil {
		t.Fatalf("get po: %v", err)
	}
	if po.Status != "draft" || po.TotalTZS != 6000 {
		t.Fatalf("draft po = status %s total %d, want draft/6000", po.Status, po.TotalTZS)
	}
	if len(po.Items) != 2 {
		t.Fatalf("po items = %+v, want 2", po.Items)
	}
	names := map[string]bool{}
	for _, it := range po.Items {
		if it.NameSnapshot == "" || it.ItemID != oil.ID && it.ItemID != salt.ID {
			t.Fatalf("po item %+v has no snapshotted name or unknown item", it)
		}
		names[it.NameSnapshot] = true
	}
	if !names["Oil"] || !names["Salt"] {
		t.Fatalf("po item names = %v, want Oil and Salt", names)
	}

	po, err = st.SendPO(ctx, merchant, poID)
	if err != nil {
		t.Fatalf("send po: %v", err)
	}
	if po.Status != "sent" {
		t.Fatalf("sent po status = %s, want sent", po.Status)
	}
	// Sending again conflicts.
	if _, err := st.SendPO(ctx, merchant, poID); !errors.Is(err, ErrStatusConflict) {
		t.Fatalf("re-send = %v, want ErrStatusConflict", err)
	}

	po, err = st.ReceivePO(ctx, merchant, poID, []POReceipt{{ItemID: oil.ID, Quantity: 4}})
	if err != nil {
		t.Fatalf("partial receive: %v", err)
	}
	if po.Status != "partially_received" {
		t.Fatalf("status after partial receive = %s, want partially_received", po.Status)
	}
	oilNow, _ := st.GetItem(ctx, merchant, oil.ID)
	if oilNow.Quantity != 4 {
		t.Fatalf("oil quantity after partial receive = %d, want 4", oilNow.Quantity)
	}

	po, err = st.ReceivePO(ctx, merchant, poID, []POReceipt{
		{ItemID: oil.ID, Quantity: 6},
		{ItemID: salt.ID, Quantity: 4},
	})
	if err != nil {
		t.Fatalf("final receive: %v", err)
	}
	if po.Status != "received" {
		t.Fatalf("status after final receive = %s, want received", po.Status)
	}
	oilNow, _ = st.GetItem(ctx, merchant, oil.ID)
	saltNow, _ := st.GetItem(ctx, merchant, salt.ID)
	if oilNow.Quantity != 10 || saltNow.Quantity != 4 {
		t.Fatalf("stock after receipt = oil %d salt %d, want 10/4", oilNow.Quantity, saltNow.Quantity)
	}

	if _, err := st.ReceivePO(ctx, merchant, poID, []POReceipt{{ItemID: oil.ID, Quantity: 1}}); !errors.Is(err, ErrReceiptExceedsQty) {
		t.Fatalf("over-receive = %v, want ErrReceiptExceedsQty", err)
	}
	if _, err := st.CancelPO(ctx, merchant, poID); !errors.Is(err, ErrAlreadyCancelled) {
		t.Fatalf("cancel after received = %v, want ErrAlreadyCancelled", err)
	}
}

// TestSupplierSuspendedBlocksPO: creating a purchase order against a
// suspended supplier is rejected before any PO row exists.
func TestSupplierSuspendedBlocksPO(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	supplier, err := st.CreateSupplier(ctx, merchant, "Dodoma Foods", "+255700000001", "active")
	if err != nil {
		t.Fatalf("create supplier: %v", err)
	}
	if _, err := st.UpdateSupplier(ctx, merchant, supplier.ID, supplier.Name, supplier.ContactPhone, "suspended"); err != nil {
		t.Fatalf("suspend supplier: %v", err)
	}
	item := createItem(t, st, merchant, "Beans", "BEANS-1", 0, 5)

	poID, err := st.CreatePO(ctx, merchant, supplier.ID, []POItemInput{
		{ItemID: item.ID, Quantity: 5, UnitCostTZS: 800},
	}, "blocked order")
	if !errors.Is(err, ErrSupplierSuspended) {
		t.Fatalf("create po vs suspended supplier = %v (id %s), want ErrSupplierSuspended", err, poID)
	}
	var poCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM purchase_orders WHERE merchant_id = $1`, merchant).Scan(&poCount); err != nil {
		t.Fatalf("po count query: %v", err)
	}
	if poCount != 0 {
		t.Fatalf("po rows = %d, want 0", poCount)
	}
}

// TestListItemsPagination: 25 items page as 20 + 5 via the cursor.
func TestListItemsPagination(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	for i := 0; i < 25; i++ {
		if _, err := st.CreateItem(ctx, merchant,
			fmt.Sprintf("Item %02d", i), fmt.Sprintf("IT-%02d", i), 5, "u", 100); err != nil {
			t.Fatalf("create item %d: %v", i, err)
		}
	}

	page1, next, err := st.ListItems(ctx, merchant, false, 20, "")
	if err != nil {
		t.Fatalf("page 1: %v", err)
	}
	if len(page1) != 20 || next == "" {
		t.Fatalf("page 1 = %d items, next %q; want 20 + cursor", len(page1), next)
	}
	page2, next, err := st.ListItems(ctx, merchant, false, 20, next)
	if err != nil {
		t.Fatalf("page 2: %v", err)
	}
	if len(page2) != 5 || next != "" {
		t.Fatalf("page 2 = %d items, next %q; want 5 + no cursor", len(page2), next)
	}
	seen := make(map[uuid.UUID]bool, 25)
	for _, p := range [][]Item{page1, page2} {
		for _, it := range p {
			if seen[it.ID] {
				t.Fatalf("item %s appears on two pages", it.ID)
			}
			seen[it.ID] = true
		}
	}
	// A malformed cursor is rejected, never silently reset.
	if _, _, err := st.ListItems(ctx, merchant, false, 20, "not-a-cursor"); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("bad cursor = %v, want ErrInvalidCursor", err)
	}
}

// TestConcurrentAdjusts: 10 goroutines adjusting the same item +1 each must
// serialize on the row lock and land exactly +10 with no negative stock.
func TestConcurrentAdjusts(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	it := createItem(t, st, merchant, "Flour", "FLR-2", 5, 3)

	const workers = 10
	var wg sync.WaitGroup
	errs := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := st.Adjust(ctx, merchant, it.ID, 1, "concurrent test"); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent adjust: %v", err)
	}

	got, err := st.GetItem(ctx, merchant, it.ID)
	if err != nil {
		t.Fatalf("get item: %v", err)
	}
	if got.Quantity != 5+workers {
		t.Fatalf("quantity after 10 concurrent +1 = %d, want %d", got.Quantity, 5+workers)
	}
	var adjustmentCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM inventory_adjustments WHERE item_id = $1`, it.ID).Scan(&adjustmentCount); err != nil {
		t.Fatalf("adjustment count query: %v", err)
	}
	if adjustmentCount != 1+workers {
		t.Fatalf("adjustment rows = %d, want %d", adjustmentCount, 1+workers)
	}
}

// TestSyncConfigDefaults: a missing row honestly returns the default
// disabled config; an upsert persists and is returned verbatim.
func TestSyncConfigDefaults(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	cfg, err := st.GetSyncConfig(ctx, merchant)
	if err != nil {
		t.Fatalf("get default sync config: %v", err)
	}
	if cfg.Enabled || cfg.Provider != "" {
		t.Fatalf("default sync config = %+v, want disabled with no provider", cfg)
	}

	cfg.Enabled = true
	cfg.Provider = "pos"
	got, err := st.UpsertSyncConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("upsert sync config: %v", err)
	}
	if !got.Enabled || got.Provider != "pos" {
		t.Fatalf("upserted sync config = %+v", got)
	}
	cfg2, err := st.GetSyncConfig(ctx, merchant)
	if err != nil {
		t.Fatalf("reload sync config: %v", err)
	}
	if !cfg2.Enabled || cfg2.Provider != "pos" {
		t.Fatalf("reloaded sync config = %+v", cfg2)
	}
}

// TestSupplierReturns covers create -> list -> get -> decide, scoped to the
// merchant.
func TestSupplierReturns(t *testing.T) {
	pool := newTestPool(t)
	merchant := setupUser(t, pool)
	st := NewStore(pool)
	ctx := context.Background()

	supplier, err := st.CreateSupplier(ctx, merchant, "Kilimanjaro Drinks", "+255700000002", "active")
	if err != nil {
		t.Fatalf("create supplier: %v", err)
	}
	item := createItem(t, st, merchant, "Juice", "JUICE-1", 12, 5)

	ret, err := st.CreateSupplierReturn(ctx, merchant, supplier.ID, item.ID, nil, 3, "expired stock")
	if err != nil {
		t.Fatalf("create supplier return: %v", err)
	}
	if ret.Status != "requested" {
		t.Fatalf("return status = %s, want requested", ret.Status)
	}

	returns, err := st.ListSupplierReturns(ctx, merchant)
	if err != nil {
		t.Fatalf("list supplier returns: %v", err)
	}
	if len(returns) != 1 {
		t.Fatalf("supplier returns = %d, want 1", len(returns))
	}
	got, err := st.GetSupplierReturn(ctx, merchant, ret.ID)
	if err != nil {
		t.Fatalf("get supplier return: %v", err)
	}
	if got.Quantity != 3 || got.Reason != "expired stock" {
		t.Fatalf("supplier return = %+v", got)
	}

	decided, err := st.DecideSupplierReturn(ctx, merchant, ret.ID, "accepted")
	if err != nil {
		t.Fatalf("decide supplier return: %v", err)
	}
	if decided.Status != "accepted" {
		t.Fatalf("decided status = %s, want accepted", decided.Status)
	}
	// A second decision on the same return is not allowed.
	if _, err := st.DecideSupplierReturn(ctx, merchant, ret.ID, "rejected"); !errors.Is(err, ErrSupplierReturnNotFound) {
		t.Fatalf("re-decide = %v, want ErrSupplierReturnNotFound", err)
	}
}
