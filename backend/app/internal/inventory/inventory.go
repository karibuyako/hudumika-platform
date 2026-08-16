// Package inventory is the bounded context for merchant stock, its
// append-only adjustment log, low-stock alerts, suppliers, purchase orders
// and supplier returns (backend/DATA-MODEL.md "Inventory and procurement").
// Money is int64 TZS only; every mutation that changes stock quantity is
// guarded against negative balances inside a transaction.
package inventory

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced to the API layer (ERROR-CODES.md "Inventory and
// procurement").
var (
	ErrNegativeStock          = errors.New("inventory adjustment would drive stock negative")
	ErrItemNotFound           = errors.New("inventory item not found")
	ErrAlertNotFound          = errors.New("inventory alert not found")
	ErrReasonRequired         = errors.New("inventory adjustment reason required")
	ErrSupplierNotFound       = errors.New("supplier not found")
	ErrSupplierSuspended      = errors.New("supplier is suspended")
	ErrPurchaseOrderNotFound  = errors.New("purchase order not found")
	ErrStatusConflict         = errors.New("purchase order status conflict")
	ErrAlreadyCancelled       = errors.New("purchase order already cancelled")
	ErrReceiptExceedsQty      = errors.New("receipt quantity exceeds ordered quantity")
	ErrSupplierReturnNotFound = errors.New("supplier return not found")
	ErrInvalidCursor          = errors.New("invalid pagination cursor")
)

// Store wraps the connection pool for all inventory persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Item is one row of inventory_items.
type Item struct {
	ID                uuid.UUID
	MerchantID        uuid.UUID
	Name              string
	SKU               string
	Quantity          int
	LowStockThreshold int
	Unit              string
	CostTZS           int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// Adjustment is one row of the append-only inventory_adjustments log.
type Adjustment struct {
	ID        uuid.UUID
	ItemID    uuid.UUID
	Delta     int
	Reason    string
	ByUserID  uuid.UUID
	CreatedAt time.Time
}

// Alert is one row of inventory_alerts.
type Alert struct {
	ID         uuid.UUID
	ItemID     uuid.UUID
	Type       string
	Message    string
	Resolved   bool
	CreatedAt  time.Time
	ResolvedAt *time.Time
}

// SyncConfig is the per-merchant sync-config master record.
type SyncConfig struct {
	MerchantID      uuid.UUID
	Enabled         bool
	Provider        string
	URL             string
	APIKeyEncrypted string
	UpdatedAt       time.Time
}

// Supplier is one row of suppliers.
type Supplier struct {
	ID           uuid.UUID
	MerchantID   uuid.UUID
	Name         string
	ContactPhone string
	Status       string
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// POItem is one line item of a purchase order.
type POItem struct {
	ID               uuid.UUID
	ItemID           uuid.UUID
	NameSnapshot     string
	Quantity         int
	UnitCostTZS      int64
	ReceivedQuantity int
}

// PurchaseOrder is one purchase_orders row with its line items.
type PurchaseOrder struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	SupplierID uuid.UUID
	Status     string
	TotalTZS   int64
	Note       string
	CreatedAt  time.Time
	UpdatedAt  time.Time
	Items      []POItem
}

// SupplierReturn is one row of supplier_returns.
type SupplierReturn struct {
	ID              uuid.UUID
	MerchantID      uuid.UUID
	SupplierID      uuid.UUID
	PurchaseOrderID *uuid.UUID
	ItemID          uuid.UUID
	Quantity        int
	Reason          string
	Status          string
	CreatedAt       time.Time
}

const itemColumns = `id, merchant_id, name, sku, quantity, low_stock_threshold, unit, cost_tzs, created_at, updated_at`

func scanItem(row pgx.Row) (Item, error) {
	var it Item
	err := row.Scan(&it.ID, &it.MerchantID, &it.Name, &it.SKU, &it.Quantity,
		&it.LowStockThreshold, &it.Unit, &it.CostTZS, &it.CreatedAt, &it.UpdatedAt)
	if err != nil {
		return Item{}, err
	}
	return it, nil
}

// CreateItem inserts a stock item for the merchant.
func (s *Store) CreateItem(ctx context.Context, merchantID uuid.UUID, name, sku string, lowStockThreshold int, unit string, costTZS int64) (Item, error) {
	it, err := scanItem(s.pool.QueryRow(ctx,
		`INSERT INTO inventory_items (merchant_id, name, sku, low_stock_threshold, unit, cost_tzs)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING `+itemColumns,
		merchantID, name, sku, lowStockThreshold, unit, costTZS))
	if err != nil {
		return Item{}, fmt.Errorf("inventory: create item: %w", err)
	}
	return it, nil
}

// GetItem loads one item owned by the merchant; ErrItemNotFound when absent.
func (s *Store) GetItem(ctx context.Context, merchantID, itemID uuid.UUID) (Item, error) {
	it, err := scanItem(s.pool.QueryRow(ctx,
		`SELECT `+itemColumns+` FROM inventory_items WHERE id = $1 AND merchant_id = $2`,
		itemID, merchantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Item{}, fmt.Errorf("inventory: get item %s: %w", itemID, ErrItemNotFound)
	}
	if err != nil {
		return Item{}, fmt.Errorf("inventory: get item %s: %w", itemID, err)
	}
	return it, nil
}

// ListItems returns the merchant's items, oldest first, cursor-paginated on
// (created_at, id); next is the base64 cursor of the last row when another
// page exists, else "". lowStockOnly filters to items at or below their
// low-stock threshold. A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListItems(ctx context.Context, merchantID uuid.UUID, lowStockOnly bool, limit int, cursor string) ([]Item, string, error) {
	query := `SELECT ` + itemColumns + ` FROM inventory_items WHERE merchant_id = $1`
	args := []any{merchantID}
	if lowStockOnly {
		query += ` AND quantity <= low_stock_threshold`
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("inventory: list items: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("inventory: list items: %w", err)
	}
	defer rows.Close()

	out := make([]Item, 0, limit)
	var (
		last     Item
		sentinel bool
	)
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, "", fmt.Errorf("inventory: scan item row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, it)
		last = it
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("inventory: iterate item rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// Adjust applies a signed delta to an item's stock inside a transaction and
// appends an adjustment row. A blank reason yields ErrReasonRequired (the
// API layer validates first; this is defense in depth). A result below zero
// yields ErrNegativeStock and no write at all. When the new quantity is at
// or below the low-stock threshold an alert row is inserted best-effort
// (failure never fails the adjustment). The acting user is the merchant
// session itself for this milestone (merchant id == users row id), so it is
// recorded as by_user_id.
func (s *Store) Adjust(ctx context.Context, merchantID, itemID uuid.UUID, delta int, reason string) (int, error) {
	if strings.TrimSpace(reason) == "" {
		return 0, fmt.Errorf("inventory: adjust item %s: %w", itemID, ErrReasonRequired)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("inventory: begin adjust tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		quantity  int
		threshold int
	)
	err = tx.QueryRow(ctx,
		`SELECT quantity, low_stock_threshold FROM inventory_items
		 WHERE id = $1 AND merchant_id = $2 FOR UPDATE`, itemID, merchantID).
		Scan(&quantity, &threshold)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("inventory: adjust item %s: %w", itemID, ErrItemNotFound)
	}
	if err != nil {
		return 0, fmt.Errorf("inventory: lock item %s: %w", itemID, err)
	}
	newQty := quantity + delta
	if newQty < 0 {
		return 0, fmt.Errorf("inventory: adjust item %s: %w", itemID, ErrNegativeStock)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE inventory_items SET quantity = $3, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, itemID, merchantID, newQty); err != nil {
		return 0, fmt.Errorf("inventory: update item %s: %w", itemID, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO inventory_adjustments (merchant_id, item_id, delta, reason, by_user_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		merchantID, itemID, delta, reason, merchantID); err != nil {
		return 0, fmt.Errorf("inventory: insert adjustment for %s: %w", itemID, err)
	}
	if newQty <= threshold {
		alertType := "low_stock"
		if newQty == 0 {
			alertType = "out_of_stock"
		}
		// Best-effort: a failed alert insert never fails the adjustment.
		_, _ = tx.Exec(ctx,
			`INSERT INTO inventory_alerts (merchant_id, item_id, type, message)
			 VALUES ($1, $2, $3, $4)`,
			merchantID, itemID, alertType,
			fmt.Sprintf("Stock for %s is %d (threshold %d)", itemID, newQty, threshold))
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("inventory: commit adjust: %w", err)
	}
	return newQty, nil
}

// ListAdjustments returns the merchant's adjustment log, newest first,
// cursor-paginated on (created_at, id).
func (s *Store) ListAdjustments(ctx context.Context, merchantID uuid.UUID, limit int, cursor string) ([]Adjustment, string, error) {
	query := `SELECT id, item_id, delta, reason, by_user_id, created_at
		FROM inventory_adjustments WHERE merchant_id = $1`
	args := []any{merchantID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("inventory: list adjustments: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("inventory: list adjustments: %w", err)
	}
	defer rows.Close()

	out := make([]Adjustment, 0, limit)
	for rows.Next() {
		var a Adjustment
		if err := rows.Scan(&a.ID, &a.ItemID, &a.Delta, &a.Reason, &a.ByUserID, &a.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("inventory: scan adjustment: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("inventory: iterate adjustments: %w", err)
	}
	return out, "", nil
}

// ListAlerts returns the merchant's alerts, oldest unresolved first,
// cursor-paginated on (created_at, id). Alerts are only exposed while
// unresolved (resolved_at IS NULL).
func (s *Store) ListAlerts(ctx context.Context, merchantID uuid.UUID, limit int, cursor string) ([]Alert, string, error) {
	query := `SELECT id, item_id, type, message, resolved, created_at, resolved_at
		FROM inventory_alerts WHERE merchant_id = $1 AND resolved = false`
	args := []any{merchantID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("inventory: list alerts: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("inventory: list alerts: %w", err)
	}
	defer rows.Close()

	out := make([]Alert, 0, limit)
	var (
		last     Alert
		sentinel bool
	)
	for rows.Next() {
		var a Alert
		if err := rows.Scan(&a.ID, &a.ItemID, &a.Type, &a.Message, &a.Resolved, &a.CreatedAt, &a.ResolvedAt); err != nil {
			return nil, "", fmt.Errorf("inventory: scan alert: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, a)
		last = a
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("inventory: iterate alerts: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// ResolveAlert marks one unresolved alert resolved; ErrAlertNotFound when
// the alert is missing or already resolved.
func (s *Store) ResolveAlert(ctx context.Context, alertID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE inventory_alerts SET resolved = true, resolved_at = now()
		 WHERE id = $1 AND resolved = false`, alertID)
	if err != nil {
		return fmt.Errorf("inventory: resolve alert %s: %w", alertID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("inventory: resolve alert %s: %w", alertID, ErrAlertNotFound)
	}
	return nil
}

// GetSyncConfig returns the merchant's sync config; a missing row yields a
// default disabled config, never an error.
func (s *Store) GetSyncConfig(ctx context.Context, merchantID uuid.UUID) (SyncConfig, error) {
	cfg := SyncConfig{MerchantID: merchantID, Enabled: false}
	err := s.pool.QueryRow(ctx,
		`SELECT enabled, provider, url, api_key_encrypted, updated_at
		 FROM inventory_sync_config WHERE merchant_id = $1`, merchantID).
		Scan(&cfg.Enabled, &cfg.Provider, &cfg.URL, &cfg.APIKeyEncrypted, &cfg.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return cfg, nil
	}
	if err != nil {
		return SyncConfig{}, fmt.Errorf("inventory: get sync config: %w", err)
	}
	return cfg, nil
}

// UpsertSyncConfig inserts or replaces the merchant's sync config.
func (s *Store) UpsertSyncConfig(ctx context.Context, cfg SyncConfig) (SyncConfig, error) {
	err := s.pool.QueryRow(ctx,
		`INSERT INTO inventory_sync_config (merchant_id, enabled, provider, url, api_key_encrypted)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (merchant_id) DO UPDATE
		 SET enabled = EXCLUDED.enabled, provider = EXCLUDED.provider,
		     url = EXCLUDED.url, api_key_encrypted = EXCLUDED.api_key_encrypted,
		     updated_at = now()
		 RETURNING enabled, provider, url, api_key_encrypted, updated_at`,
		cfg.MerchantID, cfg.Enabled, cfg.Provider, cfg.URL, cfg.APIKeyEncrypted).
		Scan(&cfg.Enabled, &cfg.Provider, &cfg.URL, &cfg.APIKeyEncrypted, &cfg.UpdatedAt)
	if err != nil {
		return SyncConfig{}, fmt.Errorf("inventory: upsert sync config: %w", err)
	}
	return cfg, nil
}

const supplierColumns = `id, merchant_id, name, contact_phone, status, created_at, updated_at`

// ListSuppliers returns the merchant's suppliers, oldest first.
func (s *Store) ListSuppliers(ctx context.Context, merchantID uuid.UUID) ([]Supplier, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+supplierColumns+` FROM suppliers WHERE merchant_id = $1 ORDER BY created_at, id`,
		merchantID)
	if err != nil {
		return nil, fmt.Errorf("inventory: list suppliers: %w", err)
	}
	defer rows.Close()

	out := make([]Supplier, 0, 8)
	for rows.Next() {
		var sup Supplier
		if err := rows.Scan(&sup.ID, &sup.MerchantID, &sup.Name, &sup.ContactPhone,
			&sup.Status, &sup.CreatedAt, &sup.UpdatedAt); err != nil {
			return nil, fmt.Errorf("inventory: scan supplier: %w", err)
		}
		out = append(out, sup)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("inventory: iterate suppliers: %w", err)
	}
	return out, nil
}

// CreateSupplier inserts a supplier (status defaults to active).
func (s *Store) CreateSupplier(ctx context.Context, merchantID uuid.UUID, name, contactPhone, status string) (Supplier, error) {
	var sup Supplier
	err := s.pool.QueryRow(ctx,
		`INSERT INTO suppliers (merchant_id, name, contact_phone, status)
		 VALUES ($1, $2, $3, $4) RETURNING `+supplierColumns,
		merchantID, name, contactPhone, status).
		Scan(&sup.ID, &sup.MerchantID, &sup.Name, &sup.ContactPhone,
			&sup.Status, &sup.CreatedAt, &sup.UpdatedAt)
	if err != nil {
		return Supplier{}, fmt.Errorf("inventory: create supplier: %w", err)
	}
	return sup, nil
}

// GetSupplier loads one supplier owned by the merchant; ErrSupplierNotFound
// when absent (existence is never leaked across merchants).
func (s *Store) GetSupplier(ctx context.Context, merchantID, supplierID uuid.UUID) (Supplier, error) {
	var sup Supplier
	err := s.pool.QueryRow(ctx,
		`SELECT `+supplierColumns+` FROM suppliers WHERE id = $1 AND merchant_id = $2`,
		supplierID, merchantID).
		Scan(&sup.ID, &sup.MerchantID, &sup.Name, &sup.ContactPhone,
			&sup.Status, &sup.CreatedAt, &sup.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Supplier{}, fmt.Errorf("inventory: get supplier %s: %w", supplierID, ErrSupplierNotFound)
	}
	if err != nil {
		return Supplier{}, fmt.Errorf("inventory: get supplier %s: %w", supplierID, err)
	}
	return sup, nil
}

// UpdateSupplier patches name, contact phone and/or status; a missing or
// cross-merchant supplier yields ErrSupplierNotFound.
func (s *Store) UpdateSupplier(ctx context.Context, merchantID, supplierID uuid.UUID, name, contactPhone, status string) (Supplier, error) {
	var sup Supplier
	err := s.pool.QueryRow(ctx,
		`UPDATE suppliers
		 SET name = $3, contact_phone = $4, status = $5, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2 RETURNING `+supplierColumns,
		supplierID, merchantID, name, contactPhone, status).
		Scan(&sup.ID, &sup.MerchantID, &sup.Name, &sup.ContactPhone,
			&sup.Status, &sup.CreatedAt, &sup.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Supplier{}, fmt.Errorf("inventory: update supplier %s: %w", supplierID, ErrSupplierNotFound)
	}
	if err != nil {
		return Supplier{}, fmt.Errorf("inventory: update supplier %s: %w", supplierID, err)
	}
	return sup, nil
}

// DeleteSupplier deactivates a supplier (status -> suspended); a missing or
// cross-merchant supplier yields ErrSupplierNotFound.
func (s *Store) DeleteSupplier(ctx context.Context, merchantID, supplierID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE suppliers SET status = 'suspended', updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`, supplierID, merchantID)
	if err != nil {
		return fmt.Errorf("inventory: delete supplier %s: %w", supplierID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("inventory: delete supplier %s: %w", supplierID, ErrSupplierNotFound)
	}
	return nil
}

// POItemInput is the create-PO item shape: the inventory item id, the
// quantity and the agreed unit cost in TZS.
type POItemInput struct {
	ItemID      uuid.UUID
	Quantity    int
	UnitCostTZS int64
}

const poColumns = `id, merchant_id, supplier_id, status, total_tzs, note, created_at, updated_at`

func scanPO(row pgx.Row) (PurchaseOrder, error) {
	var po PurchaseOrder
	err := row.Scan(&po.ID, &po.MerchantID, &po.SupplierID, &po.Status, &po.TotalTZS,
		&po.Note, &po.CreatedAt, &po.UpdatedAt)
	if err != nil {
		return PurchaseOrder{}, err
	}
	return po, nil
}

// loadPOItems loads the line items for one or more purchase orders.
func (s *Store) loadPOItems(ctx context.Context, poIDs []uuid.UUID) (map[uuid.UUID][]POItem, error) {
	items := make(map[uuid.UUID][]POItem, len(poIDs))
	rows, err := s.pool.Query(ctx,
		`SELECT id, purchase_order_id, item_id, name_snapshot, quantity, unit_cost_tzs, received_quantity
		 FROM purchase_order_items WHERE purchase_order_id = ANY($1) ORDER BY id`, poIDs)
	if err != nil {
		return nil, fmt.Errorf("inventory: load po items: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var it POItem
		var poID uuid.UUID
		if err := rows.Scan(&it.ID, &poID, &it.ItemID, &it.NameSnapshot, &it.Quantity,
			&it.UnitCostTZS, &it.ReceivedQuantity); err != nil {
			return nil, fmt.Errorf("inventory: scan po item: %w", err)
		}
		items[poID] = append(items[poID], it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("inventory: iterate po items: %w", err)
	}
	return items, nil
}

// GetPO loads one purchase order with its items, scoped to the merchant;
// ErrPurchaseOrderNotFound when absent or not owned by the caller.
func (s *Store) GetPO(ctx context.Context, merchantID, poID uuid.UUID) (PurchaseOrder, error) {
	po, err := scanPO(s.pool.QueryRow(ctx,
		`SELECT `+poColumns+` FROM purchase_orders WHERE id = $1 AND merchant_id = $2`,
		poID, merchantID))
	if errors.Is(err, pgx.ErrNoRows) {
		return PurchaseOrder{}, fmt.Errorf("inventory: get po %s: %w", poID, ErrPurchaseOrderNotFound)
	}
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: get po %s: %w", poID, err)
	}
	items, err := s.loadPOItems(ctx, []uuid.UUID{po.ID})
	if err != nil {
		return PurchaseOrder{}, err
	}
	po.Items = items[po.ID]
	return po, nil
}

// CreatePO creates a draft purchase order for the merchant inside a
// transaction: the supplier must exist and be active (ErrSupplierNotFound /
// ErrSupplierSuspended) and every item must belong to the merchant
// (ErrItemNotFound). total_tzs is computed server-side as the sum of
// quantity * unit cost; each line's name is snapshotted at creation time.
func (s *Store) CreatePO(ctx context.Context, merchantID, supplierID uuid.UUID, items []POItemInput, note string) (uuid.UUID, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, fmt.Errorf("inventory: begin create po tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var supStatus string
	err = tx.QueryRow(ctx,
		`SELECT status FROM suppliers WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
		supplierID, merchantID).Scan(&supStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("inventory: create po supplier %s: %w", supplierID, ErrSupplierNotFound)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("inventory: lock supplier %s: %w", supplierID, err)
	}
	if supStatus != "active" {
		return uuid.Nil, fmt.Errorf("inventory: create po supplier %s: %w", supplierID, ErrSupplierSuspended)
	}

	itemIDs := make([]uuid.UUID, 0, len(items))
	for _, in := range items {
		itemIDs = append(itemIDs, in.ItemID)
	}
	names := make(map[uuid.UUID]string, len(items))
	rows, err := tx.Query(ctx,
		`SELECT id, name FROM inventory_items WHERE id = ANY($1) AND merchant_id = $2`,
		itemIDs, merchantID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("inventory: create po items lookup: %w", err)
	}
	for rows.Next() {
		var (
			id   uuid.UUID
			name string
		)
		if err := rows.Scan(&id, &name); err != nil {
			rows.Close()
			return uuid.Nil, fmt.Errorf("inventory: scan po item lookup: %w", err)
		}
		names[id] = name
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return uuid.Nil, fmt.Errorf("inventory: iterate po item lookup: %w", err)
	}
	if len(names) != len(items) {
		return uuid.Nil, fmt.Errorf("inventory: create po items: %w", ErrItemNotFound)
	}

	var total int64
	for _, in := range items {
		total += in.UnitCostTZS * int64(in.Quantity)
	}

	var poID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO purchase_orders (merchant_id, supplier_id, status, total_tzs, note)
		 VALUES ($1, $2, 'draft', $3, $4) RETURNING id`,
		merchantID, supplierID, total, note).Scan(&poID); err != nil {
		return uuid.Nil, fmt.Errorf("inventory: insert po: %w", err)
	}
	for _, in := range items {
		if _, err := tx.Exec(ctx,
			`INSERT INTO purchase_order_items
			 (purchase_order_id, item_id, name_snapshot, quantity, unit_cost_tzs)
			 VALUES ($1, $2, $3, $4, $5)`,
			poID, in.ItemID, names[in.ItemID], in.Quantity, in.UnitCostTZS); err != nil {
			return uuid.Nil, fmt.Errorf("inventory: insert po item %s: %w", in.ItemID, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, fmt.Errorf("inventory: commit create po: %w", err)
	}
	return poID, nil
}

// ListPOs returns the merchant's purchase orders (optionally filtered by
// status), newest first, cursor-paginated on (created_at, id), each with its
// line items.
func (s *Store) ListPOs(ctx context.Context, merchantID uuid.UUID, status string, limit int, cursor string) ([]PurchaseOrder, string, error) {
	query := `SELECT ` + poColumns + ` FROM purchase_orders WHERE merchant_id = $1`
	args := []any{merchantID}
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("inventory: list pos: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) < ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at DESC, id DESC LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("inventory: list pos: %w", err)
	}
	out := make([]PurchaseOrder, 0, limit)
	var (
		last     PurchaseOrder
		sentinel bool
	)
	for rows.Next() {
		po, err := scanPO(rows)
		if err != nil {
			rows.Close()
			return nil, "", fmt.Errorf("inventory: scan po: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, po)
		last = po
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("inventory: iterate pos: %w", err)
	}
	if len(out) == 0 {
		return out, "", nil
	}
	poIDs := make([]uuid.UUID, 0, len(out))
	for _, po := range out {
		poIDs = append(poIDs, po.ID)
	}
	items, err := s.loadPOItems(ctx, poIDs)
	if err != nil {
		return nil, "", err
	}
	for i := range out {
		out[i].Items = items[out[i].ID]
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// SendPO moves a draft purchase order to sent; any other state yields
// ErrStatusConflict.
func (s *Store) SendPO(ctx context.Context, merchantID, poID uuid.UUID) (PurchaseOrder, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: begin send po tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM purchase_orders WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
		poID, merchantID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return PurchaseOrder{}, fmt.Errorf("inventory: send po %s: %w", poID, ErrPurchaseOrderNotFound)
	}
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: lock po %s: %w", poID, err)
	}
	if status != "draft" {
		return PurchaseOrder{}, fmt.Errorf("inventory: send po %s: %w", poID, ErrStatusConflict)
	}
	po, err := scanPO(tx.QueryRow(ctx,
		`UPDATE purchase_orders SET status = 'sent', updated_at = now()
		 WHERE id = $1 RETURNING `+poColumns, poID))
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: update po %s: %w", poID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: commit send po: %w", err)
	}
	items, err := s.loadPOItems(ctx, []uuid.UUID{po.ID})
	if err != nil {
		return PurchaseOrder{}, err
	}
	po.Items = items[po.ID]
	return po, nil
}

// CancelPO moves a draft or sent purchase order to cancelled; any other
// state yields ErrAlreadyCancelled (or ErrStatusConflict when stock is
// already being received / received — those orders cannot be cancelled).
func (s *Store) CancelPO(ctx context.Context, merchantID, poID uuid.UUID) (PurchaseOrder, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: begin cancel po tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM purchase_orders WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
		poID, merchantID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return PurchaseOrder{}, fmt.Errorf("inventory: cancel po %s: %w", poID, ErrPurchaseOrderNotFound)
	}
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: lock po %s: %w", poID, err)
	}
	switch status {
	case "draft", "sent":
	default:
		return PurchaseOrder{}, fmt.Errorf("inventory: cancel po %s: %w", poID, ErrAlreadyCancelled)
	}
	po, err := scanPO(tx.QueryRow(ctx,
		`UPDATE purchase_orders SET status = 'cancelled', updated_at = now()
		 WHERE id = $1 RETURNING `+poColumns, poID))
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: update po %s: %w", poID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: commit cancel po: %w", err)
	}
	items, err := s.loadPOItems(ctx, []uuid.UUID{po.ID})
	if err != nil {
		return PurchaseOrder{}, err
	}
	po.Items = items[po.ID]
	return po, nil
}

// POReceipt is one received line: the item id and the quantity received.
type POReceipt struct {
	ItemID   uuid.UUID
	Quantity int
}

// ReceivePO records partial or full receipts against a sent purchase order
// inside a transaction: each receipt must not exceed the ordered quantity
// minus what was already received (ErrReceiptExceedsQty), the received
// quantity is bumped, inventory stock is increased, and the order status
// advances sent -> partially_received -> received. Receiving on a draft or
// already-received order yields ErrStatusConflict; on a cancelled order
// ErrAlreadyCancelled.
func (s *Store) ReceivePO(ctx context.Context, merchantID, poID uuid.UUID, receipts []POReceipt) (PurchaseOrder, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: begin receive po tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	err = tx.QueryRow(ctx,
		`SELECT status FROM purchase_orders WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
		poID, merchantID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return PurchaseOrder{}, fmt.Errorf("inventory: receive po %s: %w", poID, ErrPurchaseOrderNotFound)
	}
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: lock po %s: %w", poID, err)
	}
	switch status {
	case "draft":
		return PurchaseOrder{}, fmt.Errorf("inventory: receive po %s: %w", poID, ErrStatusConflict)
	case "cancelled":
		return PurchaseOrder{}, fmt.Errorf("inventory: receive po %s: %w", poID, ErrAlreadyCancelled)
	}

	allReceived := true
	for _, rec := range receipts {
		var (
			itemID    uuid.UUID
			ordered   int
			received  int
			itemOwner uuid.UUID
		)
		err = tx.QueryRow(ctx,
			`SELECT id, quantity, received_quantity FROM purchase_order_items
			 WHERE purchase_order_id = $1 AND item_id = $2 FOR UPDATE`,
			poID, rec.ItemID).Scan(&itemID, &ordered, &received)
		if errors.Is(err, pgx.ErrNoRows) {
			return PurchaseOrder{}, fmt.Errorf("inventory: receipt item %s not on po %s: %w", rec.ItemID, poID, ErrItemNotFound)
		}
		if err != nil {
			return PurchaseOrder{}, fmt.Errorf("inventory: lock receipt item %s: %w", rec.ItemID, err)
		}
		if rec.Quantity < 1 || rec.Quantity > ordered-received {
			return PurchaseOrder{}, fmt.Errorf("inventory: receipt %d of item %s: %w", rec.Quantity, rec.ItemID, ErrReceiptExceedsQty)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE purchase_order_items SET received_quantity = received_quantity + $2
			 WHERE id = $1`, itemID, rec.Quantity); err != nil {
			return PurchaseOrder{}, fmt.Errorf("inventory: bump receipt for %s: %w", rec.ItemID, err)
		}
		if err := tx.QueryRow(ctx,
			`SELECT merchant_id FROM inventory_items WHERE id = $1`, rec.ItemID).Scan(&itemOwner); err != nil {
			return PurchaseOrder{}, fmt.Errorf("inventory: receipt item owner %s: %w", rec.ItemID, err)
		}
		if itemOwner != merchantID {
			return PurchaseOrder{}, fmt.Errorf("inventory: receipt item %s: %w", rec.ItemID, ErrItemNotFound)
		}
		if _, err := tx.Exec(ctx,
			`UPDATE inventory_items SET quantity = quantity + $2, updated_at = now()
			 WHERE id = $1`, rec.ItemID, rec.Quantity); err != nil {
			return PurchaseOrder{}, fmt.Errorf("inventory: restock item %s: %w", rec.ItemID, err)
		}
		if received+rec.Quantity < ordered {
			allReceived = false
		}
	}
	newStatus := "received"
	if !allReceived {
		newStatus = "partially_received"
	}
	po, err := scanPO(tx.QueryRow(ctx,
		`UPDATE purchase_orders SET status = $2, updated_at = now()
		 WHERE id = $1 RETURNING `+poColumns, poID, newStatus))
	if err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: update po %s: %w", poID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return PurchaseOrder{}, fmt.Errorf("inventory: commit receive po: %w", err)
	}
	items, err := s.loadPOItems(ctx, []uuid.UUID{po.ID})
	if err != nil {
		return PurchaseOrder{}, err
	}
	po.Items = items[po.ID]
	return po, nil
}

// CreateSupplierReturn records a return request (status 'requested') for
// one item; the supplier must belong to the merchant and the item must
// exist. Returns the created row.
func (s *Store) CreateSupplierReturn(ctx context.Context, merchantID, supplierID, itemID uuid.UUID, purchaseOrderID *uuid.UUID, quantity int, reason string) (SupplierReturn, error) {
	if _, err := s.GetSupplier(ctx, merchantID, supplierID); err != nil {
		return SupplierReturn{}, err
	}
	if _, err := s.GetItem(ctx, merchantID, itemID); err != nil {
		return SupplierReturn{}, err
	}
	var ret SupplierReturn
	err := s.pool.QueryRow(ctx,
		`INSERT INTO supplier_returns (merchant_id, supplier_id, purchase_order_id, item_id, quantity, reason)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING
		 id, merchant_id, supplier_id, purchase_order_id, item_id, quantity, reason, status, created_at`,
		merchantID, supplierID, purchaseOrderID, itemID, quantity, reason).
		Scan(&ret.ID, &ret.MerchantID, &ret.SupplierID, &ret.PurchaseOrderID, &ret.ItemID,
			&ret.Quantity, &ret.Reason, &ret.Status, &ret.CreatedAt)
	if err != nil {
		return SupplierReturn{}, fmt.Errorf("inventory: create supplier return: %w", err)
	}
	return ret, nil
}

// ListSupplierReturns returns the merchant's supplier returns, newest first.
func (s *Store) ListSupplierReturns(ctx context.Context, merchantID uuid.UUID) ([]SupplierReturn, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, merchant_id, supplier_id, purchase_order_id, item_id, quantity, reason, status, created_at
		 FROM supplier_returns WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC`, merchantID)
	if err != nil {
		return nil, fmt.Errorf("inventory: list supplier returns: %w", err)
	}
	defer rows.Close()
	out := make([]SupplierReturn, 0, 8)
	for rows.Next() {
		var ret SupplierReturn
		if err := rows.Scan(&ret.ID, &ret.MerchantID, &ret.SupplierID, &ret.PurchaseOrderID, &ret.ItemID,
			&ret.Quantity, &ret.Reason, &ret.Status, &ret.CreatedAt); err != nil {
			return nil, fmt.Errorf("inventory: scan supplier return: %w", err)
		}
		out = append(out, ret)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("inventory: iterate supplier returns: %w", err)
	}
	return out, nil
}

// GetSupplierReturn loads one supplier return owned by the merchant;
// ErrSupplierReturnNotFound when absent.
func (s *Store) GetSupplierReturn(ctx context.Context, merchantID, returnID uuid.UUID) (SupplierReturn, error) {
	var ret SupplierReturn
	err := s.pool.QueryRow(ctx,
		`SELECT id, merchant_id, supplier_id, purchase_order_id, item_id, quantity, reason, status, created_at
		 FROM supplier_returns WHERE id = $1 AND merchant_id = $2`, returnID, merchantID).
		Scan(&ret.ID, &ret.MerchantID, &ret.SupplierID, &ret.PurchaseOrderID, &ret.ItemID,
			&ret.Quantity, &ret.Reason, &ret.Status, &ret.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SupplierReturn{}, fmt.Errorf("inventory: get supplier return %s: %w", returnID, ErrSupplierReturnNotFound)
	}
	if err != nil {
		return SupplierReturn{}, fmt.Errorf("inventory: get supplier return %s: %w", returnID, err)
	}
	return ret, nil
}

// DecideSupplierReturn advances a requested return to accepted, rejected or
// received; a missing or already-decided return yields
// ErrSupplierReturnNotFound.
func (s *Store) DecideSupplierReturn(ctx context.Context, merchantID, returnID uuid.UUID, status string) (SupplierReturn, error) {
	var ret SupplierReturn
	err := s.pool.QueryRow(ctx,
		`UPDATE supplier_returns SET status = $3
		 WHERE id = $1 AND merchant_id = $2 AND status = 'requested' RETURNING
		 id, merchant_id, supplier_id, purchase_order_id, item_id, quantity, reason, status, created_at`,
		returnID, merchantID, status).
		Scan(&ret.ID, &ret.MerchantID, &ret.SupplierID, &ret.PurchaseOrderID, &ret.ItemID,
			&ret.Quantity, &ret.Reason, &ret.Status, &ret.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SupplierReturn{}, fmt.Errorf("inventory: decide supplier return %s: %w", returnID, ErrSupplierReturnNotFound)
	}
	if err != nil {
		return SupplierReturn{}, fmt.Errorf("inventory: decide supplier return %s: %w", returnID, err)
	}
	return ret, nil
}

// encodeCursor renders the (created_at, id) tuple as a base64url cursor.
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

// parseCursor decodes a cursor produced by encodeCursor.
func parseCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("parse cursor id: %w", err)
	}
	return createdAt, id, nil
}
