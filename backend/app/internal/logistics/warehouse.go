// WAREHOUSE STOCK and FULFILLMENT lane (API-CONTRACT.yaml
// /warehouses/{warehouseId}/stock and /warehouses/{warehouseId}/fulfill,
// ERROR-CODES.md "Logistics"): per-warehouse stock lines (warehouse_stock,
// migration 00051) with a reserved channel, and the regional-warehouse
// fulfill flow that converts an order's items into reserved stock plus a
// pending shipment.
//
// The warehouse registry itself (warehouses table, migration 00041) lives in
// the logistics-extra lane (ExtraStore); this store owns the stock lines on
// top of it. Every mutation runs inside a transaction and holds the
// warehouse row FOR UPDATE (WAREHOUSE_OUT_OF_SERVICE guard) and the stock
// rows FOR UPDATE, so concurrent adjusts and fulfills serialize on the line.
//
// Fulfill creates the physical twin as a shipments row (migration 00027)
// with origin_hub_id NULL (warehouses are standalone, not hubs; the column
// is nullable) and the warehouse name in current_location, plus a
// shipment_events row whose note is 'warehouse fulfill' (the shipments table
// has no note column; the event ledger carries it). one order -> one
// shipment is enforced by the shipments.order_id unique key
// (SHIPMENT_ALREADY_EXISTS).
package logistics

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors for the warehouse stock lane, surfaced to the API layer as
// the ERROR-CODES.md envelopes (WAREHOUSE_NOT_FOUND reuses the extra lane's
// ErrWarehouseNotFound; WAREHOUSE_OUT_OF_SERVICE, INVENTORY_NEGATIVE_STOCK,
// WAREHOUSE_STOCK_UNAVAILABLE, ORDER_NOT_FOUND, SHIPMENT_ALREADY_EXISTS).
var (
	ErrWarehouseOutOfService = errors.New("logistics: warehouse is out of service")
	ErrNegativeStock         = errors.New("logistics: warehouse stock would go negative")
	ErrStockUnavailable      = errors.New("logistics: insufficient stock to fulfill")
	ErrStockNotFound         = errors.New("logistics: warehouse stock row not found")
	ErrOrderNotFound         = errors.New("logistics: order not found")
)

// WarehouseStore wraps the connection pool for the warehouse stock and
// fulfillment persistence. It is a distinct store type from the core Store
// and the ExtraStore (same package, same pool).
type WarehouseStore struct {
	pool *pgxpool.Pool
}

// NewWarehouseStore returns a WarehouseStore bound to the given pool.
func NewWarehouseStore(pool *pgxpool.Pool) *WarehouseStore {
	return &WarehouseStore{pool: pool}
}

// StockRow is one warehouse_stock row.
type StockRow struct {
	ID              uuid.UUID
	WarehouseID     uuid.UUID
	CatalogueItemID uuid.UUID
	Quantity        int
	Reserved        int
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const warehouseStockColumns = `id, warehouse_id, catalogue_item_id, quantity, reserved, created_at, updated_at`

// AdjustStock applies a signed delta to a warehouse's stock line for one
// catalogue item inside a transaction. The warehouse must exist
// (ErrWarehouseNotFound) and be active (ErrWarehouseOutOfService); a result
// below zero yields ErrNegativeStock and no write at all. The stock line is
// upserted: a first-time delta inserts the line with the delta as quantity.
// Returns the new on-hand quantity.
func (s *WarehouseStore) AdjustStock(ctx context.Context, warehouseID, itemID uuid.UUID, delta int) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("logistics: begin adjust warehouse stock tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := s.lockActiveWarehouse(ctx, tx, warehouseID); err != nil {
		return 0, err
	}

	var quantity int
	err = tx.QueryRow(ctx,
		`SELECT quantity FROM warehouse_stock
		 WHERE warehouse_id = $1 AND catalogue_item_id = $2 FOR UPDATE`,
		warehouseID, itemID).Scan(&quantity)
	switch {
	case err == nil:
		newQty := quantity + delta
		if newQty < 0 {
			return 0, fmt.Errorf("logistics: adjust warehouse stock %s/%s: %w", warehouseID, itemID, ErrNegativeStock)
		}
		if err := tx.QueryRow(ctx,
			`UPDATE warehouse_stock SET quantity = $3, updated_at = now()
			 WHERE warehouse_id = $1 AND catalogue_item_id = $2 RETURNING quantity`,
			warehouseID, itemID, newQty).Scan(&newQty); err != nil {
			return 0, fmt.Errorf("logistics: update warehouse stock %s/%s: %w", warehouseID, itemID, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return 0, fmt.Errorf("logistics: commit adjust warehouse stock: %w", err)
		}
		return newQty, nil
	case errors.Is(err, pgx.ErrNoRows):
		// Fresh line: a negative first delta is a negative-balance attempt.
		if delta < 0 {
			return 0, fmt.Errorf("logistics: adjust warehouse stock %s/%s: %w", warehouseID, itemID, ErrNegativeStock)
		}
		if err := tx.QueryRow(ctx,
			`INSERT INTO warehouse_stock (warehouse_id, catalogue_item_id, quantity)
			 VALUES ($1, $2, $3) RETURNING quantity`,
			warehouseID, itemID, delta).Scan(&quantity); err != nil {
			return 0, fmt.Errorf("logistics: insert warehouse stock %s/%s: %w", warehouseID, itemID, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return 0, fmt.Errorf("logistics: commit adjust warehouse stock: %w", err)
		}
		return quantity, nil
	default:
		return 0, fmt.Errorf("logistics: lock warehouse stock %s/%s: %w", warehouseID, itemID, err)
	}
}

// GetStock loads one stock line; ErrStockNotFound when the line is absent.
func (s *WarehouseStore) GetStock(ctx context.Context, warehouseID, itemID uuid.UUID) (StockRow, error) {
	row, err := scanStockRow(s.pool.QueryRow(ctx,
		`SELECT `+warehouseStockColumns+` FROM warehouse_stock
		 WHERE warehouse_id = $1 AND catalogue_item_id = $2`,
		warehouseID, itemID))
	if errors.Is(err, pgx.ErrNoRows) {
		return StockRow{}, fmt.Errorf("logistics: get warehouse stock %s/%s: %w", warehouseID, itemID, ErrStockNotFound)
	}
	if err != nil {
		return StockRow{}, fmt.Errorf("logistics: get warehouse stock %s/%s: %w", warehouseID, itemID, err)
	}
	return row, nil
}

// ListStock returns a warehouse's stock lines, oldest first, cursor-
// paginated on (created_at, id); next is the base64 cursor of the last
// returned row when another page exists, else "". An unknown warehouse
// yields ErrWarehouseNotFound; a malformed cursor yields ErrInvalidCursor.
func (s *WarehouseStore) ListStock(ctx context.Context, warehouseID uuid.UUID, limit int, cursor string) ([]StockRow, string, error) {
	var one int
	if err := s.pool.QueryRow(ctx, `SELECT 1 FROM warehouses WHERE id = $1`, warehouseID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return nil, "", fmt.Errorf("logistics: list warehouse stock: %w", ErrWarehouseNotFound)
	} else if err != nil {
		return nil, "", fmt.Errorf("logistics: list warehouse stock warehouse check: %w", err)
	}
	query := `SELECT ` + warehouseStockColumns + ` FROM warehouse_stock WHERE warehouse_id = $1`
	args := []any{warehouseID}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: list warehouse stock: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("logistics: list warehouse stock: %w", err)
	}
	defer rows.Close()

	out := make([]StockRow, 0, limit)
	var (
		last     StockRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanStockRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("logistics: scan warehouse stock row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("logistics: iterate warehouse stock rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// Fulfill ships an order from a warehouse: every order item must have enough
// available stock (quantity - reserved) at the warehouse
// (ErrStockUnavailable otherwise), the stock lines are decremented and
// reserved, and a pending shipment is created from the warehouse (origin
// hub NULL, warehouse name as current_location, 'warehouse fulfill' on the
// created event — the shipments table has no note column). The warehouse
// must exist (ErrWarehouseNotFound) and be active
// (ErrWarehouseOutOfService); the order must exist (ErrOrderNotFound); an
// order that already has a shipment yields ErrAlreadyExists
// (SHIPMENT_ALREADY_EXISTS). All of it is one transaction: an insufficient
// line rolls everything back.
func (s *WarehouseStore) Fulfill(ctx context.Context, warehouseID, orderID uuid.UUID) error {
	for attempt := 0; attempt < 3; attempt++ {
		waybill, err := newWaybill()
		if err != nil {
			return fmt.Errorf("logistics: generate waybill: %w", err)
		}
		err = s.fulfillOnce(ctx, warehouseID, orderID, waybill)
		if err == nil {
			return nil
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "shipments_waybill_number_key" {
			// A waybill collision is a coin flip: retry with a fresh number
			// (the failed transaction rolled back, so no stock moved).
			continue
		}
		return err
	}
	return fmt.Errorf("logistics: fulfill %s from warehouse %s: waybill generation exhausted: %w", orderID, warehouseID, ErrAlreadyExists)
}

func (s *WarehouseStore) fulfillOnce(ctx context.Context, warehouseID, orderID uuid.UUID, waybill string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("logistics: begin fulfill tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	warehouseName, err := s.lockActiveWarehouse(ctx, tx, warehouseID)
	if err != nil {
		return err
	}

	var one int
	if err := tx.QueryRow(ctx, `SELECT 1 FROM orders WHERE id = $1`, orderID).Scan(&one); errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("logistics: fulfill %s: %w", orderID, ErrOrderNotFound)
	} else if err != nil {
		return fmt.Errorf("logistics: fulfill %s order check: %w", orderID, err)
	}
	// One order -> one shipment: an order that already has a shipment is
	// rejected before any stock moves (the shipments.order_id unique key is
	// the backstop; this check also keeps the availability error from
	// shadowing the already-shipped conflict).
	if err := tx.QueryRow(ctx, `SELECT 1 FROM shipments WHERE order_id = $1`, orderID).Scan(&one); err == nil {
		return fmt.Errorf("logistics: fulfill %s: %w", orderID, ErrAlreadyExists)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("logistics: fulfill %s shipment check: %w", orderID, err)
	}

	needed := make(map[uuid.UUID]int)
	rows, err := tx.Query(ctx,
		`SELECT catalogue_item_id, quantity FROM order_items WHERE order_id = $1`, orderID)
	if err != nil {
		return fmt.Errorf("logistics: fulfill %s load order items: %w", orderID, err)
	}
	for rows.Next() {
		var (
			itemID *uuid.UUID
			qty    int
		)
		if err := rows.Scan(&itemID, &qty); err != nil {
			rows.Close()
			return fmt.Errorf("logistics: fulfill %s scan order item: %w", orderID, err)
		}
		if itemID == nil {
			rows.Close()
			// An item without a catalogue reference cannot be matched to
			// warehouse stock.
			return fmt.Errorf("logistics: fulfill %s: item without catalogue reference: %w", orderID, ErrStockUnavailable)
		}
		needed[*itemID] += qty
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return fmt.Errorf("logistics: fulfill %s iterate order items: %w", orderID, err)
	}

	// Lock the lines in sorted id order so concurrent fulfills touching the
	// same item sets never deadlock on lock order.
	itemIDs := make([]uuid.UUID, 0, len(needed))
	for itemID := range needed {
		itemIDs = append(itemIDs, itemID)
	}
	sort.Slice(itemIDs, func(i, j int) bool { return itemIDs[i].String() < itemIDs[j].String() })
	for _, itemID := range itemIDs {
		var quantity, reserved int
		err := tx.QueryRow(ctx,
			`SELECT quantity, reserved FROM warehouse_stock
			 WHERE warehouse_id = $1 AND catalogue_item_id = $2 FOR UPDATE`,
			warehouseID, itemID).Scan(&quantity, &reserved)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("logistics: fulfill %s: item %s not stocked: %w", orderID, itemID, ErrStockUnavailable)
		}
		if err != nil {
			return fmt.Errorf("logistics: fulfill %s lock stock %s: %w", orderID, itemID, err)
		}
		if needed[itemID] > quantity-reserved {
			return fmt.Errorf("logistics: fulfill %s: item %s needs %d, available %d: %w",
				orderID, itemID, needed[itemID], quantity-reserved, ErrStockUnavailable)
		}
	}
	for _, itemID := range itemIDs {
		if _, err := tx.Exec(ctx,
			`UPDATE warehouse_stock
			 SET quantity = quantity - $3, reserved = reserved + $3, updated_at = now()
			 WHERE warehouse_id = $1 AND catalogue_item_id = $2`,
			warehouseID, itemID, needed[itemID]); err != nil {
			return fmt.Errorf("logistics: fulfill %s reserve item %s: %w", orderID, itemID, err)
		}
	}

	var shipmentID uuid.UUID
	if err := tx.QueryRow(ctx,
		`INSERT INTO shipments (order_id, waybill_number, status, origin_hub_id, destination_hub_id, current_location)
		 VALUES ($1, $2, 'pending', NULL, NULL, $3) RETURNING id`,
		orderID, waybill, warehouseName).Scan(&shipmentID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// order_id unique: the order already has a shipment; waybill
			// collisions surface raw so the caller retries with a fresh one.
			if pgErr.ConstraintName != "shipments_waybill_number_key" {
				return fmt.Errorf("logistics: fulfill %s: %w", orderID, ErrAlreadyExists)
			}
		}
		return fmt.Errorf("logistics: fulfill %s insert shipment: %w", orderID, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO shipment_events (shipment_id, status, by, note)
		 VALUES ($1, 'created', NULL, 'warehouse fulfill')`, shipmentID); err != nil {
		return fmt.Errorf("logistics: fulfill %s insert created event: %w", orderID, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO packages (shipment_id, attributes) VALUES ($1, $2)`,
		shipmentID, `{"compatible":true}`); err != nil {
		return fmt.Errorf("logistics: fulfill %s insert package: %w", orderID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("logistics: commit fulfill %s: %w", orderID, err)
	}
	return nil
}

// lockActiveWarehouse locks a warehouse row FOR UPDATE and returns its name;
// ErrWarehouseNotFound when absent, ErrWarehouseOutOfService when it is not
// active.
func (s *WarehouseStore) lockActiveWarehouse(ctx context.Context, tx pgx.Tx, id uuid.UUID) (string, error) {
	var name, status string
	err := tx.QueryRow(ctx, `SELECT name, status FROM warehouses WHERE id = $1 FOR UPDATE`, id).Scan(&name, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("logistics: warehouse %s: %w", id, ErrWarehouseNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("logistics: lock warehouse %s: %w", id, err)
	}
	if status != WarehouseStatusActive {
		return "", fmt.Errorf("logistics: warehouse %s is %s: %w", id, status, ErrWarehouseOutOfService)
	}
	return name, nil
}

func scanStockRow(s rowScanner) (StockRow, error) {
	var row StockRow
	err := s.Scan(&row.ID, &row.WarehouseID, &row.CatalogueItemID, &row.Quantity, &row.Reserved,
		&row.CreatedAt, &row.UpdatedAt)
	return row, err
}
