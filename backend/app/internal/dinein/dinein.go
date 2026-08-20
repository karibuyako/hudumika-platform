// Package dinein is the bounded context for dine-in tables, QR ordering
// and table reservations. It talks directly to PostgreSQL via a
// pgxpool.Pool. Dine-in totals are always computed server-side from the
// shared catalogue (the contract's DineInOrderCreate carries no prices);
// clients never supply money (backend/README.md).
package dinein

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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced to the API layer. Callers distinguish a missing
// table (ErrTableNotFound), a table that already has an open order
// (ErrTableInUse), a missing order or reservation, a guarded transition
// that lost the race (ErrConflict), a catalogue line that is not orderable
// (ErrItemUnavailable), a reservation scheduled in the past (ErrTimeInPast),
// a fully booked table (ErrTableFull), a reservation that can no longer be
// cancelled (ErrNotCancellable) and a malformed pagination cursor
// (ErrInvalidCursor).
var (
	ErrTableNotFound       = errors.New("dine-in table not found")
	ErrOrderNotFound       = errors.New("dine-in order not found")
	ErrReservationNotFound = errors.New("reservation not found")
	ErrConflict            = errors.New("dine-in order state conflict")
	ErrTableInUse          = errors.New("dine-in table has an open order")
	ErrItemUnavailable     = errors.New("catalogue item unavailable")
	ErrTimeInPast          = errors.New("reservation scheduled in the past")
	ErrTableFull           = errors.New("reservation table full")
	ErrNotCancellable      = errors.New("reservation not cancellable")
	ErrInvalidCursor       = errors.New("invalid pagination cursor")
)

// Store wraps the connection pool for all dine-in persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// TableRow is one row of the dine_in_tables table.
type TableRow struct {
	ID                   uuid.UUID
	MerchantID           uuid.UUID
	Label                string
	Capacity             int
	Active               bool
	CurrentDineInOrderID *uuid.UUID
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// CreateTableInput is the input shape for creating a dine-in table.
type CreateTableInput struct {
	MerchantID uuid.UUID
	Label      string
	Capacity   int
}

// UpdateTableInput is the partial-update shape for a dine-in table; nil
// fields keep their current value.
type UpdateTableInput struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	Label      *string
	Capacity   *int
	Active     *bool
}

// OrderItem is one line of the jsonb snapshot stored on
// dine_in_orders.items at order time.
type OrderItem struct {
	CatalogueItemID uuid.UUID `json:"catalogueItemId"`
	Name            string    `json:"name"`
	Quantity        int       `json:"quantity"`
	UnitPriceTZS    int64     `json:"unitPriceTZS"`
	Options         []string  `json:"options,omitempty"`
}

// OrderRow is one row of the dine_in_orders table.
type OrderRow struct {
	ID             uuid.UUID
	MerchantID     uuid.UUID
	TableID        uuid.UUID
	CustomerUserID *uuid.UUID
	Status         string
	Items          []OrderItem
	TotalTZS       int64
	PaidAt         *time.Time
	IdempotencyKey *string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// CreateOrderItem is one requested line: catalogue reference, quantity and
// options. Prices are looked up and computed server-side inside
// CreateDineInOrder.
type CreateOrderItem struct {
	CatalogueItemID uuid.UUID
	Quantity        int
	Options         []string
}

// CreateDineInOrderInput is the input shape for opening a dine-in order.
type CreateDineInOrderInput struct {
	CustomerUserID uuid.UUID
	MerchantID     uuid.UUID
	TableID        uuid.UUID
	Items          []CreateOrderItem
	IdempotencyKey string
}

// ReservationRow is one row of the reservations table.
type ReservationRow struct {
	ID             uuid.UUID
	MerchantID     uuid.UUID
	TableID        uuid.UUID
	CustomerUserID uuid.UUID
	PartySize      int
	ReservedFor    time.Time
	Status         string
	Note           *string
	IdempotencyKey *string
	CreatedAt      time.Time
}

// CreateReservationInput is the input shape for creating a reservation.
type CreateReservationInput struct {
	CustomerUserID uuid.UUID
	MerchantID     uuid.UUID
	TableID        uuid.UUID
	PartySize      int
	ReservedFor    time.Time
	Note           *string
	IdempotencyKey string
}

const (
	tableColumns       = `id, merchant_id, label, capacity, active, current_dine_in_order_id, created_at, updated_at`
	orderColumns       = `id, merchant_id, table_id, customer_user_id, status, items, total_tzs, paid_at, idempotency_key, created_at, updated_at`
	reservationColumns = `id, merchant_id, table_id, customer_user_id, party_size, reserved_for, status, note, idempotency_key, created_at`

	// reservationOverlapWindow is how far around a reserved_for timestamp a
	// table counts as occupied by that reservation.
	reservationOverlapWindow = 2 * time.Hour
)

// ListTables returns the tables of one merchant, ordered by label; a zero
// merchant id (staff sessions) lists every table. Soft-deleted tables
// (active=false) are hidden — they are kept only so open dine-in orders
// retain their foreign key (FIX: dine-in soft-delete leak).
func (s *Store) ListTables(ctx context.Context, merchantID uuid.UUID) ([]TableRow, error) {
	query := `SELECT ` + tableColumns + ` FROM dine_in_tables`
	args := make([]any, 0, 1)
	if merchantID != uuid.Nil {
		args = append(args, merchantID)
		query += ` WHERE merchant_id = $1 AND active = true`
	} else {
		query += ` WHERE active = true`
	}
	query += ` ORDER BY label`

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("dinein: list tables: %w", err)
	}
	defer rows.Close()

	out := make([]TableRow, 0, 16)
	for rows.Next() {
		row, err := scanTableRow(rows)
		if err != nil {
			return nil, fmt.Errorf("dinein: scan table row: %w", err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dinein: iterate table rows: %w", err)
	}
	return out, nil
}

// GetTable loads a single dine-in table; ErrTableNotFound when absent.
func (s *Store) GetTable(ctx context.Context, id uuid.UUID) (*TableRow, error) {
	row, err := scanTableRow(s.pool.QueryRow(ctx,
		`SELECT `+tableColumns+` FROM dine_in_tables WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("dinein: get table %s: %w", id, ErrTableNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("dinein: get table %s: %w", id, err)
	}
	return &row, nil
}

// CreateTable inserts a dine-in table and returns the created row.
func (s *Store) CreateTable(ctx context.Context, in CreateTableInput) (TableRow, error) {
	row, err := scanTableRow(s.pool.QueryRow(ctx,
		`INSERT INTO dine_in_tables (merchant_id, label, capacity)
		 VALUES ($1, $2, $3)
		 RETURNING `+tableColumns,
		in.MerchantID, in.Label, in.Capacity))
	if err != nil {
		return TableRow{}, fmt.Errorf("dinein: insert table: %w", err)
	}
	return row, nil
}

// UpdateTable applies the non-nil fields of in to the table owned by
// in.MerchantID; ErrTableNotFound when the table is missing or belongs to a
// different merchant. It returns the refreshed row.
func (s *Store) UpdateTable(ctx context.Context, in UpdateTableInput) (*TableRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE dine_in_tables
		 SET label = COALESCE($3, label),
		     capacity = COALESCE($4, capacity),
		     active = COALESCE($5, active),
		     updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`,
		in.ID, in.MerchantID, in.Label, in.Capacity, in.Active)
	if err != nil {
		return nil, fmt.Errorf("dinein: update table %s: %w", in.ID, err)
	}
	if tag.RowsAffected() == 0 {
		return nil, fmt.Errorf("dinein: update table %s: %w", in.ID, ErrTableNotFound)
	}
	return s.GetTable(ctx, in.ID)
}

// SetTableActive flips the active flag of a table owned by merchantID;
// ErrTableNotFound when the table is missing or belongs to a different
// merchant. It returns the refreshed row.
func (s *Store) SetTableActive(ctx context.Context, id, merchantID uuid.UUID, active bool) (*TableRow, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE dine_in_tables SET active = $3, updated_at = now()
		 WHERE id = $1 AND merchant_id = $2`,
		id, merchantID, active)
	if err != nil {
		return nil, fmt.Errorf("dinein: set table %s active=%t: %w", id, active, err)
	}
	if tag.RowsAffected() == 0 {
		return nil, fmt.Errorf("dinein: set table %s active=%t: %w", id, active, ErrTableNotFound)
	}
	return s.GetTable(ctx, id)
}

// CreateDineInOrder opens a dine-in order (status 'open') for a table in
// one transaction: the table must exist, be active and belong to the
// merchant (ErrTableNotFound), and must not already host an open order
// (ErrTableInUse). Totals are recomputed server-side from the catalogue
// rows at insert time (the contract carries no prices); an unknown,
// unavailable or foreign item yields ErrItemUnavailable. The table row is
// locked FOR UPDATE so two concurrent orders on one table cannot both win.
// A duplicate (customer_user_id, idempotency_key) replays the original
// order instead of failing.
func (s *Store) CreateDineInOrder(ctx context.Context, in CreateDineInOrderInput) (OrderRow, error) {
	// Idempotent replay: a duplicate (customer, key) returns the original
	// order before any table/state check, so a retry of a successful create
	// never trips the table-in-use gate.
	if in.IdempotencyKey != "" {
		if existing, err := s.GetDineInOrderByKey(ctx, in.CustomerUserID, in.IdempotencyKey); err == nil {
			return existing, nil
		}
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return OrderRow{}, fmt.Errorf("dinein: begin create order tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var table TableRow
	err = tx.QueryRow(ctx,
		`SELECT id, merchant_id, capacity, active FROM dine_in_tables WHERE id = $1 FOR UPDATE`,
		in.TableID).Scan(&table.ID, &table.MerchantID, &table.Capacity, &table.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderRow{}, fmt.Errorf("dinein: create order: table %s: %w", in.TableID, ErrTableNotFound)
	}
	if err != nil {
		return OrderRow{}, fmt.Errorf("dinein: create order: lock table %s: %w", in.TableID, err)
	}
	if !table.Active || table.MerchantID != in.MerchantID {
		return OrderRow{}, fmt.Errorf("dinein: create order: table %s: %w", in.TableID, ErrTableNotFound)
	}

	var openID uuid.UUID
	err = tx.QueryRow(ctx,
		`SELECT id FROM dine_in_orders
		 WHERE table_id = $1 AND status IN ('open', 'awaiting_payment', 'paid')
		 LIMIT 1`, in.TableID).Scan(&openID)
	if err == nil {
		return OrderRow{}, fmt.Errorf("dinein: create order: table %s: %w", in.TableID, ErrTableInUse)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return OrderRow{}, fmt.Errorf("dinein: create order: check open order for table %s: %w", in.TableID, err)
	}

	ids := make([]uuid.UUID, 0, len(in.Items))
	for _, line := range in.Items {
		ids = append(ids, line.CatalogueItemID)
	}
	catalogue, err := loadCatalogueItemsInTx(ctx, tx, ids)
	if err != nil {
		return OrderRow{}, err
	}

	var (
		total int64
		lines = make([]OrderItem, 0, len(in.Items))
	)
	for _, line := range in.Items {
		item, ok := catalogue[line.CatalogueItemID]
		if !ok || !item.Available || item.MerchantID != in.MerchantID {
			return OrderRow{}, fmt.Errorf("dinein: create order: item %s: %w", line.CatalogueItemID, ErrItemUnavailable)
		}
		total += item.PriceTZS * int64(line.Quantity)
		lines = append(lines, OrderItem{
			CatalogueItemID: line.CatalogueItemID,
			Name:            item.Name,
			Quantity:        line.Quantity,
			UnitPriceTZS:    item.PriceTZS,
			Options:         line.Options,
		})
	}

	items, err := json.Marshal(lines)
	if err != nil {
		return OrderRow{}, fmt.Errorf("dinein: encode order items: %w", err)
	}

	var row OrderRow
	scanner := tx.QueryRow(ctx,
		`INSERT INTO dine_in_orders (merchant_id, table_id, customer_user_id, status, items, total_tzs, idempotency_key)
		 VALUES ($1, $2, $3, 'open', $4, $5, $6)
		 RETURNING `+orderColumns,
		in.MerchantID, in.TableID, in.CustomerUserID, items, total, in.IdempotencyKey)
	row, err = scanOrderRow(scanner)
	if err != nil {
		if isIdempotencyViolation(err) {
			return s.GetDineInOrderByKey(ctx, in.CustomerUserID, in.IdempotencyKey)
		}
		return OrderRow{}, fmt.Errorf("dinein: insert order: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE dine_in_tables SET current_dine_in_order_id = $1, updated_at = now() WHERE id = $2`,
		row.ID, in.TableID); err != nil {
		return OrderRow{}, fmt.Errorf("dinein: mark table %s occupied: %w", in.TableID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return OrderRow{}, fmt.Errorf("dinein: commit create order: %w", err)
	}
	return row, nil
}

// GetDineInOrder loads a single dine-in order row; ErrOrderNotFound when
// absent.
func (s *Store) GetDineInOrder(ctx context.Context, id uuid.UUID) (*OrderRow, error) {
	row, err := scanOrderRow(s.pool.QueryRow(ctx,
		`SELECT `+orderColumns+` FROM dine_in_orders WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("dinein: get order %s: %w", id, ErrOrderNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("dinein: get order %s: %w", id, err)
	}
	return &row, nil
}

// GetDineInOrderByKey loads the order a (customer, idempotency key) pair
// created, used to replay duplicate creates; ErrOrderNotFound when absent.
func (s *Store) GetDineInOrderByKey(ctx context.Context, customerUserID uuid.UUID, idempotencyKey string) (OrderRow, error) {
	row, err := scanOrderRow(s.pool.QueryRow(ctx,
		`SELECT `+orderColumns+` FROM dine_in_orders
		 WHERE customer_user_id = $1 AND idempotency_key = $2`,
		customerUserID, idempotencyKey))
	if errors.Is(err, pgx.ErrNoRows) {
		return OrderRow{}, fmt.Errorf("dinein: get order by key: %w", ErrOrderNotFound)
	}
	if err != nil {
		return OrderRow{}, fmt.Errorf("dinein: get order by key: %w", err)
	}
	return row, nil
}

// ListMyDineInOrders returns the customer's dine-in orders, oldest first,
// cursor-paginated on (created_at, id), with an optional status filter.
// limit is exclusive of the sentinel row. next is the base64 cursor of the
// last returned row when another page exists, else "". A malformed cursor
// yields ErrInvalidCursor.
func (s *Store) ListMyDineInOrders(ctx context.Context, customerUserID uuid.UUID, status string, limit int, cursor string) ([]OrderRow, string, error) {
	query := `SELECT ` + orderColumns + ` FROM dine_in_orders WHERE customer_user_id = $1`
	args := make([]any, 0, 6)
	args = append(args, customerUserID)
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("dinein: list my orders: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("dinein: list my orders: %w", err)
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
			return nil, "", fmt.Errorf("dinein: scan order row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("dinein: iterate order rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// TransitionDineInOrder moves a dine-in order from one of fromStatuses to
// toStatus with a guarded UPDATE; a 0-row update (missing order or status
// outside fromStatuses) yields ErrConflict. The actor id is accepted for
// the future audit trail; there is no event log in this milestone. Moving
// to 'paid' stamps paid_at; moving to 'closed' frees the table's
// current_dine_in_order_id so a new order can open.
func (s *Store) TransitionDineInOrder(ctx context.Context, orderID uuid.UUID, fromStatuses []string, toStatus string, actorID uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("dinein: begin transition tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE dine_in_orders SET status = $1, updated_at = now()
		 WHERE id = $2 AND status = ANY($3)`,
		toStatus, orderID, fromStatuses)
	if err != nil {
		return fmt.Errorf("dinein: transition order %s: %w", orderID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("dinein: transition order %s: %w", orderID, ErrConflict)
	}

	if toStatus == "paid" {
		if _, err := tx.Exec(ctx,
			`UPDATE dine_in_orders SET paid_at = now() WHERE id = $1`, orderID); err != nil {
			return fmt.Errorf("dinein: stamp paid_at for order %s: %w", orderID, err)
		}
	}
	if toStatus == "closed" {
		if _, err := tx.Exec(ctx,
			`UPDATE dine_in_tables SET current_dine_in_order_id = NULL, updated_at = now()
			 WHERE current_dine_in_order_id = $1`, orderID); err != nil {
			return fmt.Errorf("dinein: free table of order %s: %w", orderID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("dinein: commit transition %s: %w", orderID, err)
	}
	return nil
}

// GetOpenOrderForTable returns the order currently hosted by a table — any
// order that is open, awaiting payment or paid but not yet closed — or
// (nil, nil) when the table is free. It backs the DINE_IN_TABLE_IN_USE
// checks and the table status projection.
func (s *Store) GetOpenOrderForTable(ctx context.Context, tableID uuid.UUID) (*OrderRow, error) {
	row, err := scanOrderRow(s.pool.QueryRow(ctx,
		`SELECT `+orderColumns+` FROM dine_in_orders
		 WHERE table_id = $1 AND status IN ('open', 'awaiting_payment', 'paid')
		 ORDER BY created_at LIMIT 1`, tableID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("dinein: get open order for table %s: %w", tableID, err)
	}
	return &row, nil
}

// CreateReservation reserves a table in one transaction: the table must
// exist and belong to the merchant (ErrTableNotFound), reserved_for must be
// in the future (ErrTimeInPast), and the sum of overlapping
// requested/confirmed/seated party sizes must fit the table capacity
// (ErrTableFull). The table row is locked FOR UPDATE so concurrent
// reservations on one table are serialized and exactly one wins a
// capacity-1 race. A duplicate (customer_user_id, idempotency_key) replays
// the original reservation instead of failing.
func (s *Store) CreateReservation(ctx context.Context, in CreateReservationInput) (ReservationRow, error) {
	// Idempotent replay: a duplicate (customer, key) returns the original
	// reservation before the capacity check, so a retry of a successful
	// create never trips the table-full gate.
	if in.IdempotencyKey != "" {
		if existing, err := s.GetReservationByKey(ctx, in.CustomerUserID, in.IdempotencyKey); err == nil {
			return existing, nil
		}
	}

	if !in.ReservedFor.After(time.Now()) {
		return ReservationRow{}, fmt.Errorf("dinein: create reservation: %w", ErrTimeInPast)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReservationRow{}, fmt.Errorf("dinein: begin create reservation tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		merchantID uuid.UUID
		capacity   int
	)
	err = tx.QueryRow(ctx,
		`SELECT merchant_id, capacity FROM dine_in_tables WHERE id = $1 FOR UPDATE`,
		in.TableID).Scan(&merchantID, &capacity)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReservationRow{}, fmt.Errorf("dinein: create reservation: table %s: %w", in.TableID, ErrTableNotFound)
	}
	if err != nil {
		return ReservationRow{}, fmt.Errorf("dinein: create reservation: lock table %s: %w", in.TableID, err)
	}
	if merchantID != in.MerchantID {
		return ReservationRow{}, fmt.Errorf("dinein: create reservation: table %s: %w", in.TableID, ErrTableNotFound)
	}

	var seated int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE(SUM(party_size), 0) FROM reservations
		 WHERE table_id = $1
		   AND status IN ('requested', 'confirmed', 'seated')
		   AND reserved_for BETWEEN $2 AND $3`,
		in.TableID,
		in.ReservedFor.Add(-reservationOverlapWindow),
		in.ReservedFor.Add(reservationOverlapWindow)).Scan(&seated); err != nil {
		return ReservationRow{}, fmt.Errorf("dinein: create reservation: count seated for table %s: %w", in.TableID, err)
	}
	if seated+int64(in.PartySize) > int64(capacity) {
		return ReservationRow{}, fmt.Errorf("dinein: create reservation: table %s: %w", in.TableID, ErrTableFull)
	}

	var row ReservationRow
	scanner := tx.QueryRow(ctx,
		`INSERT INTO reservations (merchant_id, table_id, customer_user_id, party_size, reserved_for, note, idempotency_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING `+reservationColumns,
		in.MerchantID, in.TableID, in.CustomerUserID, in.PartySize, in.ReservedFor,
		in.Note, in.IdempotencyKey)
	row, err = scanReservationRow(scanner)
	if err != nil {
		if isIdempotencyViolation(err) {
			return s.GetReservationByKey(ctx, in.CustomerUserID, in.IdempotencyKey)
		}
		return ReservationRow{}, fmt.Errorf("dinein: insert reservation: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return ReservationRow{}, fmt.Errorf("dinein: commit create reservation: %w", err)
	}
	return row, nil
}

// GetReservation loads a single reservation; ErrReservationNotFound when
// absent.
func (s *Store) GetReservation(ctx context.Context, id uuid.UUID) (*ReservationRow, error) {
	row, err := scanReservationRow(s.pool.QueryRow(ctx,
		`SELECT `+reservationColumns+` FROM reservations WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("dinein: get reservation %s: %w", id, ErrReservationNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("dinein: get reservation %s: %w", id, err)
	}
	return &row, nil
}

// GetReservationByKey loads the reservation a (customer, idempotency key)
// pair created, used to replay duplicate creates; ErrReservationNotFound
// when absent.
func (s *Store) GetReservationByKey(ctx context.Context, customerUserID uuid.UUID, idempotencyKey string) (ReservationRow, error) {
	row, err := scanReservationRow(s.pool.QueryRow(ctx,
		`SELECT `+reservationColumns+` FROM reservations
		 WHERE customer_user_id = $1 AND idempotency_key = $2`,
		customerUserID, idempotencyKey))
	if errors.Is(err, pgx.ErrNoRows) {
		return ReservationRow{}, fmt.Errorf("dinein: get reservation by key: %w", ErrReservationNotFound)
	}
	if err != nil {
		return ReservationRow{}, fmt.Errorf("dinein: get reservation by key: %w", err)
	}
	return row, nil
}

// ListMyReservations returns the customer's reservations, oldest first,
// cursor-paginated on (created_at, id). limit is exclusive of the sentinel
// row. next is the base64 cursor of the last returned row when another page
// exists, else "". A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListMyReservations(ctx context.Context, customerUserID uuid.UUID, limit int, cursor string) ([]ReservationRow, string, error) {
	query := `SELECT ` + reservationColumns + ` FROM reservations WHERE customer_user_id = $1`
	args := make([]any, 0, 4)
	args = append(args, customerUserID)
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("dinein: list my reservations: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("dinein: list my reservations: %w", err)
	}
	defer rows.Close()

	out := make([]ReservationRow, 0, limit)
	var (
		last     ReservationRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanReservationRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("dinein: scan reservation row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("dinein: iterate reservation rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// CancelReservation moves a reservation from requested/confirmed to
// cancelled with a guarded UPDATE; a 0-row update (missing reservation or a
// status that is no longer cancellable) yields ErrNotCancellable. The actor
// id is accepted for the future audit trail.
func (s *Store) CancelReservation(ctx context.Context, reservationID uuid.UUID, actorID uuid.UUID) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE reservations SET status = 'cancelled'
		 WHERE id = $1 AND status IN ('requested', 'confirmed')`,
		reservationID)
	if err != nil {
		return fmt.Errorf("dinein: cancel reservation %s: %w", reservationID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("dinein: cancel reservation %s: %w", reservationID, ErrNotCancellable)
	}
	return nil
}

// catalogueItem is the projection of a catalogue_items row used for
// computing dine-in totals.
type catalogueItem struct {
	ID         uuid.UUID
	MerchantID uuid.UUID
	Name       string
	PriceTZS   int64
	Available  bool
}

// loadCatalogueItemsInTx loads catalogue items by id inside a transaction.
// Deleted items are never returned, so callers treat them as unavailable.
func loadCatalogueItemsInTx(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) (map[uuid.UUID]catalogueItem, error) {
	items := make(map[uuid.UUID]catalogueItem, len(ids))
	if len(ids) == 0 {
		return items, nil
	}
	rows, err := tx.Query(ctx,
		`SELECT id, merchant_id, name, price_tzs, available
		 FROM catalogue_items WHERE id = ANY($1) AND deleted_at IS NULL`, ids)
	if err != nil {
		return nil, fmt.Errorf("dinein: load catalogue items: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var it catalogueItem
		if err := rows.Scan(&it.ID, &it.MerchantID, &it.Name, &it.PriceTZS, &it.Available); err != nil {
			return nil, fmt.Errorf("dinein: scan catalogue item: %w", err)
		}
		items[it.ID] = it
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("dinein: iterate catalogue items: %w", err)
	}
	return items, nil
}

// isIdempotencyViolation reports whether err is the unique-violation raised
// by the (customer_user_id, idempotency_key) index of dine_in_orders or
// reservations.
func isIdempotencyViolation(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return strings.Contains(pgErr.ConstraintName, "idempotency")
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanTableRow(s rowScanner) (TableRow, error) {
	var row TableRow
	err := s.Scan(&row.ID, &row.MerchantID, &row.Label, &row.Capacity, &row.Active,
		&row.CurrentDineInOrderID, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return TableRow{}, err
	}
	return row, nil
}

func scanOrderRow(s rowScanner) (OrderRow, error) {
	var (
		row      OrderRow
		itemsRaw []byte
	)
	err := s.Scan(&row.ID, &row.MerchantID, &row.TableID, &row.CustomerUserID,
		&row.Status, &itemsRaw, &row.TotalTZS, &row.PaidAt, &row.IdempotencyKey,
		&row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return OrderRow{}, err
	}
	if len(itemsRaw) > 0 {
		if err := json.Unmarshal(itemsRaw, &row.Items); err != nil {
			return OrderRow{}, fmt.Errorf("dinein: decode order items: %w", err)
		}
	}
	return row, nil
}

func scanReservationRow(s rowScanner) (ReservationRow, error) {
	var row ReservationRow
	err := s.Scan(&row.ID, &row.MerchantID, &row.TableID, &row.CustomerUserID,
		&row.PartySize, &row.ReservedFor, &row.Status, &row.Note,
		&row.IdempotencyKey, &row.CreatedAt)
	if err != nil {
		return ReservationRow{}, err
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
