// Package bookings is the bounded context for customer service bookings.
// It talks directly to PostgreSQL via a pgxpool.Pool. Booking totals are
// always computed server-side from the services catalogue price; clients
// never supply money (backend/README.md: never trust price from clients).
package bookings

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

// Sentinel errors surfaced to the API layer. Callers distinguish a missing
// booking (ErrNotFound), a guarded transition that lost the race
// (ErrConflict), a booking scheduled in the past (ErrTimeInPast) and a
// malformed pagination cursor (ErrInvalidCursor).
var (
	ErrNotFound      = errors.New("booking not found")
	ErrConflict      = errors.New("booking state conflict")
	ErrTimeInPast    = errors.New("booking scheduled in the past")
	ErrInvalidCursor = errors.New("invalid pagination cursor")
)

// Store wraps the connection pool for all booking persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// ServiceRow is the projection of a services row used for booking: the
// server-side price is the only money source of truth.
type ServiceRow struct {
	ID       uuid.UUID
	Name     string
	PriceTZS int64
	Active   bool
}

// AddressSnapshot is the JSON job-address snapshot stored on bookings.
type AddressSnapshot struct {
	Label        string   `json:"label"`
	Lines        string   `json:"lines"`
	Landmark     *string  `json:"landmark,omitempty"`
	Lat          *float64 `json:"lat,omitempty"`
	Lon          *float64 `json:"lon,omitempty"`
	ContactPhone string   `json:"contactPhone"`
}

// BookingRow is one row of the bookings table.
type BookingRow struct {
	ID              uuid.UUID
	CustomerUserID  uuid.UUID
	ProviderID      uuid.UUID
	ServiceID       uuid.UUID
	Status          string
	ScheduledFor    time.Time
	DurationMinutes *int
	SubtotalTZS     int64
	DeliveryFeeTZS  int64
	PlatformFeeTZS  int64
	TaxTZS          int64
	DiscountTZS     int64
	TotalTZS        int64
	Address         *AddressSnapshot
	Description     *string
	IdempotencyKey  *string
	Version         int
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// EventRow is one append-only booking_events row.
type EventRow struct {
	BookingID uuid.UUID
	Status    string
	At        time.Time
	By        *uuid.UUID
	Note      *string
}

// BookingDetail is the full booking projection: the booking row and its
// event history.
type BookingDetail struct {
	Booking BookingRow
	Events  []EventRow
}

// CreateInput is the input shape for creating a booking draft. The price is
// looked up and computed server-side inside CreateBooking.
type CreateInput struct {
	CustomerUserID  uuid.UUID
	ProviderID      uuid.UUID
	ServiceID       uuid.UUID
	ScheduledFor    time.Time
	DurationMinutes *int
	Address         *AddressSnapshot
	Description     *string
	IdempotencyKey  string
}

const bookingColumns = `id, customer_user_id, provider_id, service_id, status, scheduled_for,
	duration_minutes, subtotal_tzs, delivery_fee_tzs, platform_fee_tzs, tax_tzs,
	discount_tzs, total_tzs, address, description, idempotency_key, version,
	created_at, updated_at`

// GetService loads a single service row for booking; ErrNotFound when
// absent.
func (s *Store) GetService(ctx context.Context, id uuid.UUID) (*ServiceRow, error) {
	var svc ServiceRow
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, price_tzs, active FROM services WHERE id = $1`, id).
		Scan(&svc.ID, &svc.Name, &svc.PriceTZS, &svc.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("bookings: get service %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("bookings: get service %s: %w", id, err)
	}
	return &svc, nil
}

// CreateBooking inserts a booking draft and its first ('created') event in
// one transaction. The total is the service price recomputed server-side
// from the services row; an unknown service yields ErrNotFound and a
// scheduled_for in the past yields ErrTimeInPast. The idempotency-key
// uniqueness violation surfaces as the wrapped Postgres error
// (bookings(customer_user_id, idempotency_key)).
func (s *Store) CreateBooking(ctx context.Context, in CreateInput) (BookingRow, error) {
	if !in.ScheduledFor.After(time.Now()) {
		return BookingRow{}, fmt.Errorf("bookings: create booking: %w", ErrTimeInPast)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return BookingRow{}, fmt.Errorf("bookings: begin create booking tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var service ServiceRow
	err = tx.QueryRow(ctx,
		`SELECT id, name, price_tzs, active FROM services WHERE id = $1`, in.ServiceID).
		Scan(&service.ID, &service.Name, &service.PriceTZS, &service.Active)
	if errors.Is(err, pgx.ErrNoRows) {
		return BookingRow{}, fmt.Errorf("bookings: create booking: service %s: %w", in.ServiceID, ErrNotFound)
	}
	if err != nil {
		return BookingRow{}, fmt.Errorf("bookings: create booking: load service %s: %w", in.ServiceID, err)
	}

	var address []byte
	if in.Address != nil {
		if address, err = json.Marshal(in.Address); err != nil {
			return BookingRow{}, fmt.Errorf("bookings: encode booking address: %w", err)
		}
	}

	var row BookingRow
	scanner := tx.QueryRow(ctx,
		`INSERT INTO bookings (customer_user_id, provider_id, service_id, status,
			scheduled_for, duration_minutes, subtotal_tzs, total_tzs, address,
			description, idempotency_key)
		 VALUES ($1, $2, $3, 'draft', $4, $5, $6, $6, $7, $8, $9)
		 RETURNING `+bookingColumns,
		in.CustomerUserID, in.ProviderID, in.ServiceID, in.ScheduledFor,
		in.DurationMinutes, service.PriceTZS, address, in.Description, in.IdempotencyKey)
	row, err = scanBookingRow(scanner)
	if err != nil {
		return BookingRow{}, fmt.Errorf("bookings: insert booking: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO booking_events (booking_id, status, by) VALUES ($1, 'created', $2)`,
		row.ID, in.CustomerUserID); err != nil {
		return BookingRow{}, fmt.Errorf("bookings: insert created event: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return BookingRow{}, fmt.Errorf("bookings: commit create booking: %w", err)
	}
	return row, nil
}

// GetBookingRow loads a single booking row; ErrNotFound when absent. It is
// the lightweight read used by transition and detail handlers.
func (s *Store) GetBookingRow(ctx context.Context, id uuid.UUID) (*BookingRow, error) {
	row, err := scanBookingRow(s.pool.QueryRow(ctx,
		`SELECT `+bookingColumns+` FROM bookings WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("bookings: get booking %s: %w", id, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("bookings: get booking %s: %w", id, err)
	}
	return &row, nil
}

// GetBookingDetail loads the booking row and its event history (two
// queries, no N+1). ErrNotFound when absent.
func (s *Store) GetBookingDetail(ctx context.Context, id uuid.UUID) (*BookingDetail, error) {
	row, err := s.GetBookingRow(ctx, id)
	if err != nil {
		return nil, err
	}
	events, err := s.listBookingEvents(ctx, id)
	if err != nil {
		return nil, err
	}
	return &BookingDetail{Booking: *row, Events: events}, nil
}

// ListMyBookings returns the customer's bookings, oldest first,
// cursor-paginated on (created_at, id). limit is exclusive of the sentinel
// row. next is the base64 cursor of the last returned row when another page
// exists, else "". A malformed cursor yields ErrInvalidCursor.
func (s *Store) ListMyBookings(ctx context.Context, customerUserID uuid.UUID, status string, limit int, cursor string) ([]BookingRow, string, error) {
	query := `SELECT ` + bookingColumns + ` FROM bookings WHERE customer_user_id = $1`
	args := make([]any, 0, 6)
	args = append(args, customerUserID)
	if status != "" {
		args = append(args, status)
		query += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("bookings: list my bookings: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("bookings: list my bookings: %w", err)
	}
	defer rows.Close()

	out := make([]BookingRow, 0, limit)
	var (
		last     BookingRow
		sentinel bool
	)
	for rows.Next() {
		row, err := scanBookingRow(rows)
		if err != nil {
			return nil, "", fmt.Errorf("bookings: scan booking row: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, row)
		last = row
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("bookings: iterate booking rows: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// TransitionBooking moves a booking from one of fromStatuses to toStatus,
// guarded by the expected version, and appends the event in the same
// transaction. It returns the new version. A 0-row update (missing booking,
// stale version, or status outside fromStatuses) yields ErrConflict.
func (s *Store) TransitionBooking(ctx context.Context, bookingID uuid.UUID, expectedVersion int, fromStatuses []string, toStatus string, actorID uuid.UUID, note string) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("bookings: begin transition tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE bookings SET status = $1, version = version + 1, updated_at = now()
		 WHERE id = $2 AND version = $3 AND status = ANY($4)`,
		toStatus, bookingID, expectedVersion, fromStatuses)
	if err != nil {
		return 0, fmt.Errorf("bookings: transition booking %s: %w", bookingID, err)
	}
	if tag.RowsAffected() == 0 {
		return 0, fmt.Errorf("bookings: transition booking %s: %w", bookingID, ErrConflict)
	}

	var noteArg any
	if note != "" {
		noteArg = note
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO booking_events (booking_id, status, by, note) VALUES ($1, $2, $3, $4)`,
		bookingID, toStatus, actorID, noteArg); err != nil {
		return 0, fmt.Errorf("bookings: append event for booking %s: %w", bookingID, err)
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("bookings: commit transition %s: %w", bookingID, err)
	}
	return expectedVersion + 1, nil
}

func (s *Store) listBookingEvents(ctx context.Context, bookingID uuid.UUID) ([]EventRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT booking_id, status, at, by, note FROM booking_events
		 WHERE booking_id = $1 ORDER BY at, id`, bookingID)
	if err != nil {
		return nil, fmt.Errorf("bookings: list booking events: %w", err)
	}
	defer rows.Close()
	events := make([]EventRow, 0, 8)
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(&e.BookingID, &e.Status, &e.At, &e.By, &e.Note); err != nil {
			return nil, fmt.Errorf("bookings: scan booking event: %w", err)
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("bookings: iterate booking events: %w", err)
	}
	return events, nil
}

// rowScanner is satisfied by both pgx.Row and pgx.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanBookingRow(s rowScanner) (BookingRow, error) {
	var (
		row     BookingRow
		address []byte
	)
	err := s.Scan(&row.ID, &row.CustomerUserID, &row.ProviderID, &row.ServiceID,
		&row.Status, &row.ScheduledFor, &row.DurationMinutes, &row.SubtotalTZS,
		&row.DeliveryFeeTZS, &row.PlatformFeeTZS, &row.TaxTZS, &row.DiscountTZS,
		&row.TotalTZS, &address, &row.Description, &row.IdempotencyKey,
		&row.Version, &row.CreatedAt, &row.UpdatedAt)
	if err != nil {
		return BookingRow{}, err
	}
	if len(address) > 0 {
		var a AddressSnapshot
		if err := json.Unmarshal(address, &a); err != nil {
			return BookingRow{}, fmt.Errorf("bookings: decode booking address: %w", err)
		}
		row.Address = &a
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
