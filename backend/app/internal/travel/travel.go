// Package travel is the bounded context for the intercity travel vertical
// (CONTRACT-ADDITIONS.md "Travel — /travel resource"). It talks directly to
// PostgreSQL via a pgxpool.Pool. Travel totals are always computed
// server-side from the option's unit price; clients never supply money.
//
// The schedule is a daily-repeating set of routes (migration 00063): each
// row fixes the departure offset from local midnight of the REQUESTED date,
// and Search issues concrete departure/arrival timestamps for that day —
// exactly the semantics of the consumer mock (mock/travel.ts optionFor).
package travel

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced to the API layer.
var (
	ErrNotFound          = errors.New("travel: not found")
	ErrIdempotencyReplay = errors.New("travel: idempotency replay")
	ErrDeparted          = errors.New("travel: departure has already left")
	ErrNoSeats           = errors.New("travel: not enough seats")
)

// Store wraps the connection pool for all travel persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Option is one travel_options row materialized for the requested date
// (contract TravelOption schema: concrete departureAt/arrivalAt).
type Option struct {
	ID                  uuid.UUID
	Mode                string
	Provider            string
	OriginCityID        string
	OriginCityName      string
	DestinationCityID   string
	DestinationCityName string
	DepartureAt         time.Time
	ArrivalAt           time.Time
	PriceTZS            int64
	SeatsAvailable      int
	// Schedule fields (not in the contract projection).
	DepartMinutes   int
	DurationMinutes int
}

// Booking is one travel_bookings row (contract TravelBooking schema).
type Booking struct {
	ID                  uuid.UUID
	TravelOptionID      uuid.UUID
	Mode                string
	OriginCityName      string
	DestinationCityName string
	DepartureAt         time.Time
	Passengers          int
	ContactPhone        string
	TotalTZS            int64
	Status              string
	CreatedAt           time.Time
}

// CreateBookingInput is the input shape for a travel booking.
type CreateBookingInput struct {
	UserID         uuid.UUID
	TravelOptionID uuid.UUID
	Passengers     int
	ContactPhone   string
	IdempotencyKey string
	Now            time.Time
}

// Search returns the options for a route on a local calendar day, optionally
// narrowed by mode. The requested date must parse as a strict YYYY-MM-DD
// local day (DateIsValid reports this before Search is called).
func (s *Store) Search(ctx context.Context, originCityID, destinationCityID, mode, date string) ([]Option, error) {
	query := `SELECT id, mode, provider, origin_city_id, origin_city_name,
		destination_city_id, destination_city_name, depart_minutes, duration_minutes,
		price_tzs, seats_available
		FROM travel_options WHERE origin_city_id = $1 AND destination_city_id = $2`
	args := []any{originCityID, destinationCityID}
	if mode != "" {
		args = append(args, mode)
		query += fmt.Sprintf(" AND mode = $%d", len(args))
	}
	query += " ORDER BY depart_minutes"

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("travel: search options: %w", err)
	}
	defer rows.Close()

	day, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("travel: search options: parse date: %w", err)
	}

	out := make([]Option, 0, 8)
	for rows.Next() {
		var (
			o               Option
			seatsAvailable  int
		)
		if err := rows.Scan(&o.ID, &o.Mode, &o.Provider, &o.OriginCityID, &o.OriginCityName,
			&o.DestinationCityID, &o.DestinationCityName, &o.DepartMinutes, &o.DurationMinutes,
			&o.PriceTZS, &seatsAvailable); err != nil {
			return nil, fmt.Errorf("travel: scan option: %w", err)
		}
		o.SeatsAvailable = seatsAvailable
		base := day.Add(time.Duration(o.DepartMinutes) * time.Minute)
		o.DepartureAt = base
		o.ArrivalAt = base.Add(time.Duration(o.DurationMinutes) * time.Minute)
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("travel: iterate options: %w", err)
	}
	return out, nil
}

// GetOption loads a single schedule row (mode/provider/cities/price plus the
// daily depart/duration offsets), the projection used when materializing a
// booking's snapshots.
func (s *Store) GetOption(ctx context.Context, optionID uuid.UUID) (*Option, error) {
	var o Option
	err := s.pool.QueryRow(ctx,
		`SELECT id, mode, provider, origin_city_id, origin_city_name,
			destination_city_id, destination_city_name, depart_minutes, duration_minutes,
			price_tzs, seats_available
		 FROM travel_options WHERE id = $1`, optionID).
		Scan(&o.ID, &o.Mode, &o.Provider, &o.OriginCityID, &o.OriginCityName,
			&o.DestinationCityID, &o.DestinationCityName, &o.DepartMinutes, &o.DurationMinutes,
			&o.PriceTZS, &o.SeatsAvailable)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("travel: get option %s: %w", optionID, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("travel: get option %s: %w", optionID, err)
	}
	return &o, nil
}

// CreateBooking books seats on a departure. The total is computed
// server-side (unit price × passengers). A duplicate idempotency key replays
// the existing booking (ErrIdempotencyReplay carries it) so a retry never
// double-books. ErrDeparted rejects departures already gone; ErrNoSeats
// rejects overbooking.
func (s *Store) CreateBooking(ctx context.Context, in CreateBookingInput) (Booking, error) {
	replayed, err := s.BookingByKey(ctx, in.UserID, in.IdempotencyKey)
	if err == nil {
		return replayed, fmt.Errorf("travel: create booking: %w", ErrIdempotencyReplay)
	}
	if !errors.Is(err, ErrNotFound) {
		return Booking{}, err
	}

	o, err := s.GetOption(ctx, in.TravelOptionID)
	if err != nil {
		return Booking{}, err
	}

	// The departure is the route's daily instance: the offset from local
	// midnight of TODAY. A departure already in the past is rejected
	// (ErrDeparted) — search for a later date, mirroring the mock.
	day := in.Now.Truncate(24 * time.Hour)
	departure := day.Add(time.Duration(o.DepartMinutes) * time.Minute)
	if !departure.After(in.Now) {
		return Booking{}, fmt.Errorf("travel: create booking: %w", ErrDeparted)
	}
	if in.Passengers > o.SeatsAvailable {
		return Booking{}, fmt.Errorf("travel: create booking: %w", ErrNoSeats)
	}

	total := o.PriceTZS * int64(in.Passengers)
	var b Booking
	err = s.pool.QueryRow(ctx,
		`INSERT INTO travel_bookings (option_id, user_id, mode, origin_city_name,
			destination_city_name, departure_at, seat_count, contact_phone, total_tzs,
			status, idempotency_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', $10)
		 RETURNING id, option_id, mode, origin_city_name, destination_city_name,
			departure_at, seat_count, contact_phone, total_tzs, status, created_at`,
		in.TravelOptionID, in.UserID, o.Mode, o.OriginCityName, o.DestinationCityName,
		departure, in.Passengers, in.ContactPhone, total, orNull(in.IdempotencyKey)).
		Scan(&b.ID, &b.TravelOptionID, &b.Mode, &b.OriginCityName, &b.DestinationCityName,
			&b.DepartureAt, &b.Passengers, &b.ContactPhone, &b.TotalTZS, &b.Status, &b.CreatedAt)
	if err != nil {
		return Booking{}, fmt.Errorf("travel: insert booking: %w", err)
	}
	return b, nil
}

// BookingByKey loads a user's booking by its idempotency key; ErrNotFound
// when absent.
func (s *Store) BookingByKey(ctx context.Context, userID uuid.UUID, key string) (Booking, error) {
	var b Booking
	err := s.pool.QueryRow(ctx,
		`SELECT id, option_id, mode, origin_city_name, destination_city_name,
			departure_at, seat_count, contact_phone, total_tzs, status, created_at
		 FROM travel_bookings WHERE user_id = $1 AND idempotency_key = $2`, userID, key).
		Scan(&b.ID, &b.TravelOptionID, &b.Mode, &b.OriginCityName, &b.DestinationCityName,
			&b.DepartureAt, &b.Passengers, &b.ContactPhone, &b.TotalTZS, &b.Status, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Booking{}, fmt.Errorf("travel: booking by key: %w", ErrNotFound)
	}
	if err != nil {
		return Booking{}, fmt.Errorf("travel: booking by key: %w", err)
	}
	return b, nil
}

// ListMyBookings returns the user's bookings, newest first (the consumer
// mock unshifts new bookings to the head).
func (s *Store) ListMyBookings(ctx context.Context, userID uuid.UUID) ([]Booking, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, option_id, mode, origin_city_name, destination_city_name,
			departure_at, seat_count, contact_phone, total_tzs, status, created_at
		 FROM travel_bookings WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("travel: list my bookings: %w", err)
	}
	defer rows.Close()
	out := make([]Booking, 0, 8)
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.TravelOptionID, &b.Mode, &b.OriginCityName, &b.DestinationCityName,
			&b.DepartureAt, &b.Passengers, &b.ContactPhone, &b.TotalTZS, &b.Status, &b.CreatedAt); err != nil {
			return nil, fmt.Errorf("travel: scan booking: %w", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("travel: iterate bookings: %w", err)
	}
	return out, nil
}

func orNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}