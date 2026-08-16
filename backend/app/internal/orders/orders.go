// Package orders is the bounded context for the merchant catalogue and
// customer orders. It talks directly to PostgreSQL via a pgxpool.Pool.
package orders

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Flat platform fees, in TZS. Prices are server-computed; clients never
// supply money (backend/README.md: never trust price from clients).
const (
	DeliveryFeeTZS int64 = 2000
	PlatformFeeTZS int64 = 1000
)

// Sentinel errors surfaced to the API layer. Callers distinguish a missing
// order (ErrNotFound), a guarded transition that lost the race
// (ErrConflict), a catalogue line that is not orderable (ErrItemUnavailable)
// and a malformed pagination cursor (ErrInvalidCursor).
var (
	ErrNotFound        = errors.New("order not found")
	ErrConflict        = errors.New("order state conflict")
	ErrItemUnavailable = errors.New("catalogue item unavailable")
	ErrInvalidCursor   = errors.New("invalid pagination cursor")
)

// Store wraps the connection pool for all order persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// ItemRow is the projection of a catalogue_items row used for ordering.
type ItemRow struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	Name       string
	PriceTZS   int64
	Available  bool
}

// AddressSnapshot is the JSON delivery-address snapshot stored on orders.
type AddressSnapshot struct {
	Label        string   `json:"label"`
	Lines        string   `json:"lines"`
	Landmark     *string  `json:"landmark,omitempty"`
	Lat          *float64 `json:"lat,omitempty"`
	Lon          *float64 `json:"lon,omitempty"`
	ContactPhone string   `json:"contactPhone"`
}

// OrderRow is one row of the orders table.
type OrderRow struct {
	ID              uuid.UUID
	No              string
	CustomerUserID  uuid.UUID
	MerchantID      uuid.UUID
	RiderID         *uuid.UUID
	Status          string
	SubtotalTZS     int64
	DeliveryFeeTZS  int64
	PlatformFeeTZS  int64
	TaxTZS          int64
	DiscountTZS     int64
	TotalTZS        int64
	DeliveryAddress *AddressSnapshot
	Note            *string
	Version         int
	Source          string
	ScheduledAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// OrderItemRow is one line of an order, snapshotted at order time.
type OrderItemRow struct {
	ID              uuid.UUID
	OrderID         uuid.UUID
	CatalogueItemID uuid.UUID
	Name            string
	Quantity        int
	UnitPriceTZS    int64
	Options         []string
}

// EventRow is one append-only order_events row.
type EventRow struct {
	OrderID uuid.UUID
	Status  string
	At      time.Time
	By      *uuid.UUID
	Note    *string
}

// OrderDetail is the full order projection: the order row, its item
// snapshots and its event history.
type OrderDetail struct {
	Order  OrderRow
	Items  []OrderItemRow
	Events []EventRow
}

// CreateOrderItem is one requested line: catalogue reference and quantity.
// Prices are looked up and computed server-side inside CreateOrder.
type CreateOrderItem struct {
	CatalogueItemID uuid.UUID
	Quantity        int
	Options         []string
}

// CreateOrderInput is the input shape for creating an order draft.
type CreateOrderInput struct {
	CustomerUserID  uuid.UUID
	MerchantID      uuid.UUID
	Items           []CreateOrderItem
	DeliveryAddress *AddressSnapshot
	Note            *string
	IdempotencyKey  string
	Source          string
}

const orderColumns = `id, no, customer_user_id, merchant_id, rider_id, status, subtotal_tzs,
	delivery_fee_tzs, platform_fee_tzs, tax_tzs, discount_tzs, total_tzs,
	delivery_address, note, version, source, scheduled_at, created_at, updated_at`

// GetCatalogueItems loads catalogue items by id in a single query. Deleted
// items are never returned, so callers treat them as unavailable.
func (s *Store) GetCatalogueItems(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]ItemRow, error) {
	items := make(map[uuid.UUID]ItemRow, len(ids))
	if len(ids) == 0 {
		return items, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, merchant_id, name, price_tzs, available
		 FROM catalogue_items WHERE id = ANY($1) AND deleted_at IS NULL`, ids)
	if err != nil {
		return nil, fmt.Errorf("orders: load catalogue items: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var it ItemRow
		if err := rows.Scan(&it.ID, &it.MerchantID, &it.Name, &it.PriceTZS, &it.Available); err != nil {
			return nil, fmt.Errorf("orders: scan catalogue item: %w", err)
		}
		items[it.ID] = it
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate catalogue items: %w", err)
	}
	return items, nil
}

// CreateOrder inserts an order draft, its item snapshots and the first
// ('created') event in one transaction. Totals are computed server-side from
// the catalogue rows at insert time; an unknown item yields
// ErrItemUnavailable. The idempotency-key uniqueness violation surfaces as
// the wrapped Postgres error (orders(customer_user_id, idempotency_key)).
func (s *Store) CreateOrder(ctx context.Context, in CreateOrderInput) (OrderRow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OrderRow{}, fmt.Errorf("orders: begin create order tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ids := make([]uuid.UUID, 0, len(in.Items))
	for _, line := range in.Items {
		ids = append(ids, line.CatalogueItemID)
	}
	catalogue, err := getCatalogueItemsInTx(ctx, tx, ids)
	if err != nil {
		return OrderRow{}, err
	}

	var (
		subtotal int64
		lines    = make([]struct {
			item ItemRow
			qty  int
			opts []string
		}, 0, len(in.Items))
	)
	for _, line := range in.Items {
		item, ok := catalogue[line.CatalogueItemID]
		if !ok || !item.Available {
			return OrderRow{}, fmt.Errorf("orders: create order: item %s: %w", line.CatalogueItemID, ErrItemUnavailable)
		}
		subtotal += item.PriceTZS * int64(line.Quantity)
		lines = append(lines, struct {
			item ItemRow
			qty  int
			opts []string
		}{item: item, qty: line.Quantity, opts: line.Options})
	}
	total := subtotal + DeliveryFeeTZS + PlatformFeeTZS

	var address []byte
	if in.DeliveryAddress != nil {
		if address, err = json.Marshal(in.DeliveryAddress); err != nil {
			return OrderRow{}, fmt.Errorf("orders: encode delivery address: %w", err)
		}
	}

	var row OrderRow
	scanner := tx.QueryRow(ctx,
		`INSERT INTO orders (customer_user_id, merchant_id, status, subtotal_tzs,
			delivery_fee_tzs, platform_fee_tzs, total_tzs, delivery_address, note,
			idempotency_key, source)
		 VALUES ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING `+orderColumns,
		in.CustomerUserID, in.MerchantID, subtotal, DeliveryFeeTZS, PlatformFeeTZS,
		total, address, in.Note, in.IdempotencyKey, in.Source)
	row, err = scanOrderRow(scanner)
	if err != nil {
		return OrderRow{}, fmt.Errorf("orders: insert order: %w", err)
	}

	for _, line := range lines {
		var options []byte
		if len(line.opts) > 0 {
			if options, err = json.Marshal(line.opts); err != nil {
				return OrderRow{}, fmt.Errorf("orders: encode item options: %w", err)
			}
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO order_items (order_id, catalogue_item_id, name_snapshot, quantity, unit_price_tzs, options)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			row.ID, line.item.ID, line.item.Name, line.qty, line.item.PriceTZS, options); err != nil {
			return OrderRow{}, fmt.Errorf("orders: insert order item: %w", err)
		}
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, by) VALUES ($1, 'created', $2)`,
		row.ID, in.CustomerUserID); err != nil {
		return OrderRow{}, fmt.Errorf("orders: insert created event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return OrderRow{}, fmt.Errorf("orders: commit create order: %w", err)
	}
	return row, nil
}

// GetOrderRow loads a single order row; ErrNotFound when absent. It is the
// lightweight read used by transition and tracking handlers.
func (s *Store) GetOrderRow(ctx context.Context, id uuid.UUID) (*OrderRow, error) {
	row, err := scanOrderRow(s.pool.QueryRow(ctx,
		`SELECT `+orderColumns+` FROM orders WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("orders: get order %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("orders: get order %s: %w", id, err)
	}
	return &row, nil
}

// GetOrderDetail loads the order row, its item snapshots and its event
// history (three queries, no N+1). ErrNotFound when absent.
func (s *Store) GetOrderDetail(ctx context.Context, id uuid.UUID) (*OrderDetail, error) {
	row, err := s.GetOrderRow(ctx, id)
	if err != nil {
		return nil, err
	}
	items, err := s.listOrderItems(ctx, id)
	if err != nil {
		return nil, err
	}
	events, err := s.listOrderEvents(ctx, id)
	if err != nil {
		return nil, err
	}
	return &OrderDetail{Order: *row, Items: items, Events: events}, nil
}

// ListOrders returns the customer's orders, newest last, cursor-paginated
// on (created_at, id). limit is exclusive of the sentinel row. next is the
// base64 cursor of the last returned row when another page exists, else "".
// A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListOrders(ctx context.Context, customerUserID uuid.UUID, status string, limit int, cursor string) ([]OrderRow, string, error) {
	query := `SELECT ` + orderColumns + ` FROM orders WHERE customer_user_id = $1`
	args := make([]any, 0, 6)
	args = append(args, customerUserID)
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("orders: list orders: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("orders: list orders: %w", err)
	}
	defer rows.Close()

	out := make([]OrderRow, 0, limit)
	var (
		last     OrderRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanOrderRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("orders: scan order row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("orders: iterate order rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// TransitionOrder moves an order from one of fromStatuses to toStatus,
// guarded by the expected version, and appends the event in the same
// transaction. It returns the new version. A 0-row update (missing order,
// stale version, or status outside fromStatuses) yields ErrConflict.
func (s *Store) TransitionOrder(ctx context.Context, orderID uuid.UUID, expectedVersion int, fromStatuses []string, toStatus string, actorID uuid.UUID, note string) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("orders: begin transition tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE orders SET status = $1, version = version + 1, updated_at = now()
		 WHERE id = $2 AND version = $3 AND status = ANY($4)`,
		toStatus, orderID, expectedVersion, fromStatuses)
	if err != nil {
		return 0, fmt.Errorf("orders: transition order %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		return 0, fmt.Errorf("orders: transition order %s: %w", orderID, ErrConflict)
	}

	var noteArg any
	if note != "" {
		noteArg = note
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, $2, $3, $4)`,
		orderID, toStatus, actorID, noteArg); err != nil {
		return 0, fmt.Errorf("orders: append event for order %s: %w", orderID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("orders: commit transition %s: %w", orderID, err)
	}
	return expectedVersion + 1, nil
}

func (s *Store) listOrderItems(ctx context.Context, orderID uuid.UUID) ([]OrderItemRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, order_id, catalogue_item_id, name_snapshot, quantity, unit_price_tzs, options
		 FROM order_items WHERE order_id = $1 ORDER BY id`, orderID)
	if err != nil {
		return nil, fmt.Errorf("orders: list order items: %w", err)
	}
	defer rows.Close()
	items := make([]OrderItemRow, 0, 8)
	for rows.Next() {
		var (
			it      OrderItemRow
			options []byte
		)
		if err := rows.Scan(&it.ID, &it.OrderID, &it.CatalogueItemID, &it.Name, &it.Quantity, &it.UnitPriceTZS, &options); err != nil {
			return nil, fmt.Errorf("orders: scan order item: %w", err)
		}
		if len(options) > 0 {
			_ = json.Unmarshal(options, &it.Options)
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate order items: %w", err)
	}
	return items, nil
}

func (s *Store) listOrderEvents(ctx context.Context, orderID uuid.UUID) ([]EventRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT order_id, status, at, by, note FROM order_events
		 WHERE order_id = $1 ORDER BY at, id`, orderID)
	if err != nil {
		return nil, fmt.Errorf("orders: list order events: %w", err)
	}
	defer rows.Close()
	events := make([]EventRow, 0, 8)
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(&e.OrderID, &e.Status, &e.At, &e.By, &e.Note); err != nil {
			return nil, fmt.Errorf("orders: scan order event: %w", err)
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate order events: %w", err)
	}
	return events, nil
}

// getCatalogueItemsInTx is the transactional variant of GetCatalogueItems.
func getCatalogueItemsInTx(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) (map[uuid.UUID]ItemRow, error) {
	items := make(map[uuid.UUID]ItemRow, len(ids))
	if len(ids) == 0 {
		return items, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT id, merchant_id, name, price_tzs, available
		 FROM catalogue_items WHERE id = ANY($1) AND deleted_at IS NULL`, ids)
	if err != nil {
		return nil, fmt.Errorf("orders: load catalogue items: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var it ItemRow
		if err := rows.Scan(&it.ID, &it.MerchantID, &it.Name, &it.PriceTZS, &it.Available); err != nil {
			return nil, fmt.Errorf("orders: scan catalogue item: %w", err)
		}
		items[it.ID] = it
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate catalogue items: %w", err)
	}
	return items, nil
}

// ORDERS-EXTRA surface (00033_orders_extra.sql): rush (hurry-up) requests,
// batch accept/reject, damage claims, receipts, source-scoped listing and
// the merchant order search. All methods below are additive; the existing
// transition/read paths are untouched.

var (
	// ErrRushNotOpen surfaces when a merchant replies to a rush that was
	// never requested (or whose acceptance window closed).
	ErrRushNotOpen = errors.New("no pending rush request")
	// ErrRushReplied surfaces when a merchant replies a second time.
	ErrRushReplied = errors.New("rush already replied")
)

// OrderSearchInput is the merchant/staff order search: an optional free-text
// term against the order number and customer phone, plus status/date range
// filters. At least one term must be present (validated by the caller).
type OrderSearchInput struct {
	Q             string
	Status        string
	From          *time.Time
	To            *time.Time
	CustomerPhone string
	Limit         int
	Cursor        string
}

// RushOrderRow is one row of the merchant rush queue projection.
type RushOrderRow struct {
	OrderID      uuid.UUID
	RequestedAt  time.Time
	RepliedAt    *time.Time
	ReplyMessage *string
	Status       string // open | replied | resolved
}

// RushOrderDetail is an order row plus its rush stamps, returned by the
// rush mutation methods (OrderRow itself carries no 00033 columns).
type RushOrderDetail struct {
	Order       OrderRow
	RequestedAt time.Time
	RepliedAt   *time.Time
	DeadlineAt  *time.Time
}

// loadRushDetail reads the rush stamps of one order; the row itself is
// loaded via GetOrderRow.
func (s *Store) loadRushDetail(ctx context.Context, orderID uuid.UUID) (*RushOrderDetail, error) {
	row, err := s.GetOrderRow(ctx, orderID)
	if err != nil {
		return nil, err
	}
	d := RushOrderDetail{Order: *row}
	if err := s.pool.QueryRow(ctx,
		`SELECT rush_requested_at, rush_replied_at, deadline_at FROM orders WHERE id = $1`, orderID).
		Scan(&d.RequestedAt, &d.RepliedAt, &d.DeadlineAt); err != nil {
		return nil, fmt.Errorf("orders: load rush stamps %s: %w", orderID, err)
	}
	return &d, nil
}

// DamageClaimRow is one order_damage_claims row.
type DamageClaimRow struct {
	ID          uuid.UUID
	OrderID     uuid.UUID
	ReporterID  *uuid.UUID
	Description string
	Status      string
	CreatedAt   time.Time
}

// ReceiptRow is one order_receipts row.
type ReceiptRow struct {
	ID        uuid.UUID
	OrderID   uuid.UUID
	URL       string
	CreatedAt time.Time
}

// SearchOrders returns merchant/staff order search results, newest last,
// keyset-paginated on (created_at, id) exactly like ListOrders. q matches
// the order number or the customer's phone; both are ILIKE-matched with the
// wildcard characters escaped.
func (s *Store) SearchOrders(ctx context.Context, in OrderSearchInput) ([]OrderRow, string, error) {
	const qualified = `o.id, o.no, o.customer_user_id, o.merchant_id, o.rider_id, o.status,
		o.subtotal_tzs, o.delivery_fee_tzs, o.platform_fee_tzs, o.tax_tzs,
		o.discount_tzs, o.total_tzs, o.delivery_address, o.note, o.version,
		o.source, o.scheduled_at, o.created_at, o.updated_at`
	query := `SELECT ` + qualified + `
		FROM orders o
		LEFT JOIN users u ON u.id = o.customer_user_id
		WHERE 1 = 1`
	args := make([]any, 0, 8)
	if in.Q != "" {
		pattern := "%" + escapeLike(in.Q) + "%"
		args = append(args, pattern)
		query += fmt.Sprintf(` AND (o.no ILIKE $%d OR u.phone ILIKE $%d)`, len(args), len(args))
	}
	if in.Status != "" {
		args = append(args, in.Status)
		query += fmt.Sprintf(` AND o.status = $%d`, len(args))
	}
	if in.From != nil {
		args = append(args, *in.From)
		query += fmt.Sprintf(` AND o.created_at >= $%d`, len(args))
	}
	if in.To != nil {
		args = append(args, in.To.Add(24*time.Hour))
		query += fmt.Sprintf(` AND o.created_at < $%d`, len(args))
	}
	if in.CustomerPhone != "" {
		args = append(args, "%"+escapeLike(in.CustomerPhone)+"%")
		query += fmt.Sprintf(` AND u.phone ILIKE $%d`, len(args))
	}
	if in.Cursor != "" {
		at, id, err := parseCursor(in.Cursor)
		if err != nil {
			return nil, "", fmt.Errorf("orders: search orders: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(` AND (o.created_at, o.id) > ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, in.Limit+1)
	query += fmt.Sprintf(` ORDER BY o.created_at, o.id LIMIT $%d`, len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("orders: search orders: %w", err)
	}
	defer rows.Close()

	out := make([]OrderRow, 0, in.Limit)
	var (
		last     OrderRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanOrderRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("orders: scan search row: %w", err)
		}
		if len(out) == in.Limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("orders: iterate search rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// RequestRush records a hurry-up request on a paid order: it stamps
// rush_requested_at and the acceptance deadline (now + 1 minute) atomically.
// A missing order yields ErrNotFound; an order that is not paid, or that
// already has a pending rush, yields ErrConflict.
func (s *Store) RequestRush(ctx context.Context, orderID uuid.UUID, actorID uuid.UUID) (*RushOrderDetail, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("orders: begin request rush tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE orders SET rush_requested_at = now(), deadline_at = now() + interval '1 minute', updated_at = now()
		 WHERE id = $1 AND status = 'paid' AND rush_requested_at IS NULL`, orderID)
	if err != nil {
		return nil, fmt.Errorf("orders: request rush %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM orders WHERE id = $1)`, orderID).Scan(&exists); err != nil {
			return nil, fmt.Errorf("orders: request rush existence check: %w", err)
		}
		if !exists {
			return nil, fmt.Errorf("orders: request rush %s: %w", orderID, ErrNotFound)
		}
		return nil, fmt.Errorf("orders: request rush %s: %w", orderID, ErrConflict)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, by) VALUES ($1, 'rush_requested', $2)`,
		orderID, actorID); err != nil {
		return nil, fmt.Errorf("orders: append rush event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("orders: commit request rush: %w", err)
	}
	return s.loadRushDetail(ctx, orderID)
}

// ReplyRush records the merchant's reply to a pending rush request. The
// reply message is appended to the event log (status 'rush_reply') so the
// timeline and the queue can read it back. A missing order yields
// ErrNotFound, a reply without a pending request ErrRushNotOpen, and a
// second reply ErrRushReplied.
func (s *Store) ReplyRush(ctx context.Context, orderID uuid.UUID, actorID uuid.UUID, message string) (*RushOrderDetail, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("orders: begin reply rush tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE orders SET rush_replied_at = now(), updated_at = now()
		 WHERE id = $1 AND rush_requested_at IS NOT NULL AND rush_replied_at IS NULL`, orderID)
	if err != nil {
		return nil, fmt.Errorf("orders: reply rush %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		var (
			exists      bool
			requestedAt *time.Time
		)
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM orders WHERE id = $1), (SELECT rush_requested_at FROM orders WHERE id = $1)`,
			orderID).Scan(&exists, &requestedAt); err != nil {
			return nil, fmt.Errorf("orders: reply rush state check: %w", err)
		}
		if !exists {
			return nil, fmt.Errorf("orders: reply rush %s: %w", orderID, ErrNotFound)
		}
		if requestedAt == nil {
			return nil, fmt.Errorf("orders: reply rush %s: %w", orderID, ErrRushNotOpen)
		}
		return nil, fmt.Errorf("orders: reply rush %s: %w", orderID, ErrRushReplied)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, 'rush_reply', $2, $3)`,
		orderID, actorID, message); err != nil {
		return nil, fmt.Errorf("orders: append rush reply event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("orders: commit reply rush: %w", err)
	}
	return s.loadRushDetail(ctx, orderID)
}

// ListRushOrders returns the merchant rush queue: every order with a
// rush_requested_at stamp, newest request first. An optional status filter
// (open | replied | resolved) is applied in Go because the derived status is
// computed from the reply stamp plus the fulfillment state.
func (s *Store) ListRushOrders(ctx context.Context, status string) ([]RushOrderRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT o.id, o.rush_requested_at, o.rush_replied_at, e.note,
		        CASE WHEN o.status IN ('completed', 'cancelled', 'refunded', 'failed', 'disputed') THEN 'resolved'
		             WHEN o.rush_replied_at IS NOT NULL THEN 'replied'
		             ELSE 'open' END AS rush_status
		 FROM orders o
		 LEFT JOIN LATERAL (
		     SELECT note FROM order_events
		     WHERE order_id = o.id AND status = 'rush_reply'
		     ORDER BY at DESC LIMIT 1
		 ) e ON true
		 WHERE o.rush_requested_at IS NOT NULL
		 ORDER BY o.rush_requested_at DESC, o.id`)
	if err != nil {
		return nil, fmt.Errorf("orders: list rush orders: %w", err)
	}
	defer rows.Close()

	out := make([]RushOrderRow, 0, 16)
	for rows.Next() {
		var r RushOrderRow
		if err := rows.Scan(&r.OrderID, &r.RequestedAt, &r.RepliedAt, &r.ReplyMessage, &r.Status); err != nil {
			return nil, fmt.Errorf("orders: scan rush order: %w", err)
		}
		if status == "" || r.Status == status {
			out = append(out, r)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate rush orders: %w", err)
	}
	return out, nil
}

// CreateDamageClaim inserts a damage claim for an order and returns the row.
// The claim starts pending.
func (s *Store) CreateDamageClaim(ctx context.Context, orderID uuid.UUID, reporterID uuid.UUID, description string) (DamageClaimRow, error) {
	var row DamageClaimRow
	err := s.pool.QueryRow(ctx,
		`INSERT INTO order_damage_claims (order_id, reporter_user_id, description)
		 VALUES ($1, $2, $3)
		 RETURNING id, order_id, reporter_user_id, description, status, created_at`,
		orderID, reporterID, description).Scan(&row.ID, &row.OrderID, &row.ReporterID, &row.Description, &row.Status, &row.CreatedAt)
	if err != nil {
		return DamageClaimRow{}, fmt.Errorf("orders: insert damage claim: %w", err)
	}
	return row, nil
}

// ListReceipts returns recent receipt rows for reprint, newest first. When
// customerUserID is non-nil only that customer's orders are included;
// merchant/staff callers pass nil to see every receipt.
func (s *Store) ListReceipts(ctx context.Context, customerUserID *uuid.UUID, limit int) ([]ReceiptRow, error) {
	query := `SELECT r.id, r.order_id, r.url, r.created_at
		FROM order_receipts r
		JOIN orders o ON o.id = r.order_id`
	args := make([]any, 0, 2)
	if customerUserID != nil {
		args = append(args, *customerUserID)
		query += fmt.Sprintf(` WHERE o.customer_user_id = $%d`, len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(` ORDER BY r.created_at DESC, r.id LIMIT $%d`, len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("orders: list receipts: %w", err)
	}
	defer rows.Close()
	out := make([]ReceiptRow, 0, limit)
	for rows.Next() {
		var r ReceiptRow
		if err := rows.Scan(&r.ID, &r.OrderID, &r.URL, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("orders: scan receipt: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate receipts: %w", err)
	}
	return out, nil
}

// AcceptOrder moves a draft/pending_payment/paid order to merchant_accepted
// and stamps accepted_at in the same guarded transaction used by
// TransitionOrder. A 0-row update yields ErrConflict. It is the batch-accept
// twin of the single-order transition.
func (s *Store) AcceptOrder(ctx context.Context, orderID uuid.UUID, expectedVersion int, actorID uuid.UUID) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("orders: begin accept tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE orders SET status = 'merchant_accepted', version = version + 1, accepted_at = now(), updated_at = now()
		 WHERE id = $1 AND version = $2 AND status = ANY($3)`,
		orderID, expectedVersion, []string{"draft", "pending_payment", "paid"})
	if err != nil {
		return 0, fmt.Errorf("orders: accept order %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		return 0, fmt.Errorf("orders: accept order %s: %w", orderID, ErrConflict)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, by) VALUES ($1, 'merchant_accepted', $2)`,
		orderID, actorID); err != nil {
		return 0, fmt.Errorf("orders: append accept event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("orders: commit accept %s: %w", orderID, err)
	}
	return expectedVersion + 1, nil
}

// RejectOrderWithReason moves a draft/pending_payment/paid order to
// cancelled, stamps the reject reason (+ optional code) and cancelled_at in
// the same guarded transaction. A 0-row update yields ErrConflict.
func (s *Store) RejectOrderWithReason(ctx context.Context, orderID uuid.UUID, expectedVersion int, reason, reasonCode string, actorID uuid.UUID) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("orders: begin reject tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var codeArg any
	if reasonCode != "" {
		codeArg = reasonCode
	}
	tag, err := tx.Exec(ctx,
		`UPDATE orders SET status = 'cancelled', version = version + 1,
			reject_reason = $4, reject_reason_code = $5, cancelled_at = now(), updated_at = now()
		 WHERE id = $1 AND version = $2 AND status = ANY($3)`,
		orderID, expectedVersion, []string{"draft", "pending_payment", "paid"}, reason, codeArg)
	if err != nil {
		return 0, fmt.Errorf("orders: reject order %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		return 0, fmt.Errorf("orders: reject order %s: %w", orderID, ErrConflict)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO order_events (order_id, status, by, note) VALUES ($1, 'cancelled', $2, $3)`,
		orderID, actorID, reason); err != nil {
		return 0, fmt.Errorf("orders: append reject event: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("orders: commit reject %s: %w", orderID, err)
	}
	return expectedVersion + 1, nil
}

// ListSourceOrders returns orders with a given source (e.g. enterprise),
// cursor-paginated exactly like ListOrders.
func (s *Store) ListSourceOrders(ctx context.Context, source, status string, limit int, cursor string) ([]OrderRow, string, error) {
	query := `SELECT ` + orderColumns + ` FROM orders WHERE source = $1`
	args := make([]any, 0, 6)
	args = append(args, source)
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(` AND status = $%d`, len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("orders: list source orders: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(` AND (created_at, id) > ($%d, $%d)`, len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(` ORDER BY created_at, id LIMIT $%d`, len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("orders: list source orders: %w", err)
	}
	defer rows.Close()

	out := make([]OrderRow, 0, limit)
	var (
		last     OrderRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanOrderRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("orders: scan source order: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("orders: iterate source orders: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// escapeLike escapes the LIKE/ILIKE wildcard characters so user input is
// matched literally.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanOrderRow(s rowScanner) (OrderRow, error) {
	var (
		row     OrderRow
		address []byte
	)
	err := s.Scan(&row.ID, &row.No, &row.CustomerUserID, &row.MerchantID, &row.RiderID,
		&row.Status, &row.SubtotalTZS, &row.DeliveryFeeTZS, &row.PlatformFeeTZS,
		&row.TaxTZS, &row.DiscountTZS, &row.TotalTZS, &address, &row.Note,
		&row.Version, &row.Source, &row.ScheduledAt, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return OrderRow{}, err
	}
	if len(address) > 0 {
		var a AddressSnapshot
		if err := json.Unmarshal(address, &a); err != nil {
			return OrderRow{}, fmt.Errorf("orders: decode delivery address: %w", err)
		}
		row.DeliveryAddress = &a
	}
	return row, nil
}

// encodeCursor packs a row's (created_at, id) keyset into a URL-safe base64
// string; parseCursor is its inverse.
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

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

// ListAdvanceOrders returns the ids of orders scheduled (scheduled_at set)
// within [from, to) for the given user, newest first.
func (s *Store) ListAdvanceOrders(ctx context.Context, userID uuid.UUID, from, to time.Time, limit int) ([]uuid.UUID, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id FROM orders
		 WHERE customer_user_id = $1 AND scheduled_at >= $2 AND scheduled_at < $3
		 ORDER BY scheduled_at DESC, id DESC LIMIT $4`, userID, from, to, limit)
	if err != nil {
		return nil, fmt.Errorf("orders: list advance orders: %w", err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("orders: scan advance order: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("orders: iterate advance orders: %w", err)
	}
	return ids, nil
}
