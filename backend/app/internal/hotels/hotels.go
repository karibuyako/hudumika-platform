// Package hotels is the bounded context for the customer hotels vertical
// (CONTRACT-ADDITIONS.md "Hotels — /hotels resource"). It talks directly to
// PostgreSQL via a pgxpool.Pool. Booking totals are always computed
// server-side from the room's per-night rate; clients never supply money
// (backend/README.md: never trust price from clients).
package hotels

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

// Sentinel errors surfaced to the API layer: a missing row (ErrNotFound), a
// malformed pagination cursor (ErrInvalidCursor), a booking that collided on
// its idempotency key (ErrIdempotencyConflict), and a booking whose room is
// not bookable (ErrRoomUnavailable).
var (
	ErrNotFound          = errors.New("hotels: not found")
	ErrInvalidCursor     = errors.New("hotels: invalid pagination cursor")
	ErrIdempotencyReplay = errors.New("hotels: idempotency replay")
	ErrRoomUnavailable   = errors.New("hotels: room unavailable")
)

// Store wraps the connection pool for all hotels persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Hotel is the projection of a hotels row for the listing (contract Hotel
// schema minus room-level detail).
type Hotel struct {
	ID               uuid.UUID
	Name             string
	CityID           string
	CityName         string
	StarRating       *int
	Rating           float64
	ReviewCount      int
	StartingPriceTZS int64
	ImageURL         *string
	Amenities        []string
	AddressLine      *string
}

// Room is one hotel_rooms row (contract HotelRoom schema).
type Room struct {
	ID                uuid.UUID
	HotelID           uuid.UUID
	Name              string
	PricePerNightTZS  int64
	Capacity          int
	Available         bool
	Amenities         []string
}

// Booking is one hotel_bookings row (contract HotelBooking schema).
type Booking struct {
	ID        uuid.UUID
	HotelID   uuid.UUID
	HotelName string
	RoomID    uuid.UUID
	RoomName  string
	CheckIn   time.Time
	CheckOut  time.Time
	Guests    int
	Nights    int
	TotalTZS  int64
	Status    string
	CreatedAt time.Time
}

// CreateBookingInput is the input shape for a hotel booking.
type CreateBookingInput struct {
	UserID         uuid.UUID
	HotelID        uuid.UUID
	RoomID         uuid.UUID
	CheckIn        time.Time
	CheckOut       time.Time
	Guests         int
	ContactPhone   string
	IdempotencyKey string
}

const hotelColumns = `id, name, city_id, city_name, star_rating, rating, review_count,
	starting_price_tzs, image_url, amenities, address_line, created_at`

// ListHotels returns hotels ordered oldest-first, keyset-paginated on
// (created_at, id) — the listing mirrors the consumer mock's seed order.
// cityId filters by the denormalized city snapshot. next is the base64
// cursor of the last returned row when another page exists, else "".
func (s *Store) ListHotels(ctx context.Context, cityID string, limit int, cursor string) ([]Hotel, string, error) {
	query := `SELECT ` + hotelColumns + ` FROM hotels`
	args := make([]any, 0, 3)
	if cityID != "" {
		args = append(args, cityID)
		query += fmt.Sprintf(" WHERE city_id = $%d", len(args))
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("hotels: list hotels: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("hotels: list hotels: %w", err)
	}
	defer rows.Close()

	out := make([]Hotel, 0, limit)
	var (
		last     HotelRow
		sentinel bool
	)
	for rows.Next() {
		h, err := scanHotel(rows)
		if err != nil {
			return nil, "", fmt.Errorf("hotels: scan hotel: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, h.Hotel)
		last = h
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("hotels: iterate hotels: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// GetHotel loads a hotel and its rooms; ErrNotFound when absent.
func (s *Store) GetHotel(ctx context.Context, hotelID uuid.UUID) (*Hotel, []Room, error) {
	h, err := s.GetHotelRow(ctx, hotelID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.pool.Query(ctx,
		`SELECT id, hotel_id, name, price_per_night_tzs, capacity, available, amenities
		 FROM hotel_rooms WHERE hotel_id = $1 ORDER BY price_per_night_tzs`, hotelID)
	if err != nil {
		return nil, nil, fmt.Errorf("hotels: list rooms %s: %w", hotelID, err)
	}
	defer rows.Close()
	rooms := make([]Room, 0, 4)
	for rows.Next() {
		var r Room
		var amenities []byte
		if err := rows.Scan(&r.ID, &r.HotelID, &r.Name, &r.PricePerNightTZS, &r.Capacity, &r.Available, &amenities); err != nil {
			return nil, nil, fmt.Errorf("hotels: scan room: %w", err)
		}
		if err := json.Unmarshal(amenities, &r.Amenities); err != nil {
			return nil, nil, fmt.Errorf("hotels: decode room amenities: %w", err)
		}
		if r.Amenities == nil {
			r.Amenities = []string{}
		}
		rooms = append(rooms, r)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("hotels: iterate rooms: %w", err)
	}
	return h, rooms, nil
}

// GetHotelRow loads a single hotels row; ErrNotFound when absent.
func (s *Store) GetHotelRow(ctx context.Context, hotelID uuid.UUID) (*Hotel, error) {
	h, err := scanHotel(s.pool.QueryRow(ctx,
		`SELECT `+hotelColumns+` FROM hotels WHERE id = $1`, hotelID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("hotels: get hotel %s: %w", hotelID, ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("hotels: get hotel %s: %w", hotelID, err)
	}
	return &h.Hotel, nil
}

// GetDescription loads the description snapshot for the detail projection
// ("" when absent — the contract field is optional).
func (s *Store) GetDescription(ctx context.Context, hotelID uuid.UUID) (string, error) {
	var desc string
	err := s.pool.QueryRow(ctx,
		`SELECT coalesce(description, '') FROM hotels WHERE id = $1`, hotelID).Scan(&desc)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("hotels: description %s: %w", hotelID, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("hotels: description %s: %w", hotelID, err)
	}
	return desc, nil
}

// CreateBooking books a room for the customer. The total is computed
// server-side (nights × room rate); the room must be available and the
// checkout after check-in. A duplicate idempotency key replays the existing
// booking (ErrIdempotencyReplay carries it) so a retry never double-books.
func (s *Store) CreateBooking(ctx context.Context, in CreateBookingInput) (Booking, error) {
	replayed, err := s.BookingByKey(ctx, in.UserID, in.IdempotencyKey)
	if err == nil {
		return replayed, fmt.Errorf("hotels: create booking: %w", ErrIdempotencyReplay)
	}
	if !errors.Is(err, ErrNotFound) {
		return Booking{}, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Booking{}, fmt.Errorf("hotels: begin create booking tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		hotelName string
		roomName  string
		roomPrice int64
		available bool
	)
	err = tx.QueryRow(ctx,
		`SELECT h.name, r.name, r.price_per_night_tzs, r.available
		 FROM hotel_rooms r JOIN hotels h ON h.id = r.hotel_id
		 WHERE r.id = $1 AND r.hotel_id = $2`, in.RoomID, in.HotelID).
		Scan(&hotelName, &roomName, &roomPrice, &available)
	if errors.Is(err, pgx.ErrNoRows) {
		return Booking{}, fmt.Errorf("hotels: create booking: %w", ErrNotFound)
	}
	if err != nil {
		return Booking{}, fmt.Errorf("hotels: load room %s: %w", in.RoomID, err)
	}
	if !available {
		return Booking{}, fmt.Errorf("hotels: create booking: %w", ErrRoomUnavailable)
	}

	nights := int(in.CheckOut.UTC().Truncate(24*time.Hour).Sub(in.CheckIn.UTC().Truncate(24 * time.Hour)).Hours() / 24)
	total := roomPrice * int64(nights)

	var b Booking
	err = tx.QueryRow(ctx,
		`INSERT INTO hotel_bookings (hotel_id, room_id, user_id, hotel_name, room_name,
			check_in, check_out, nights, guests, contact_phone, total_tzs, status, idempotency_key)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending_payment', $12)
		 RETURNING id, hotel_id, hotel_name, room_id, room_name, check_in, check_out,
			guests, nights, total_tzs, status, created_at`,
		in.HotelID, in.RoomID, in.UserID, hotelName, roomName,
		in.CheckIn, in.CheckOut, nights, in.Guests, orNull(in.ContactPhone), total, orNull(in.IdempotencyKey)).
		Scan(&b.ID, &b.HotelID, &b.HotelName, &b.RoomID, &b.RoomName, &b.CheckIn, &b.CheckOut,
			&b.Guests, &b.Nights, &b.TotalTZS, &b.Status, &b.CreatedAt)
	if err != nil {
		return Booking{}, fmt.Errorf("hotels: insert booking: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return Booking{}, fmt.Errorf("hotels: commit create booking: %w", err)
	}
	return b, nil
}

// BookingByKey loads a user's booking by its idempotency key; ErrNotFound
// when absent.
func (s *Store) BookingByKey(ctx context.Context, userID uuid.UUID, key string) (Booking, error) {
	var b Booking
	err := s.pool.QueryRow(ctx,
		`SELECT id, hotel_id, hotel_name, room_id, room_name, check_in, check_out,
			guests, nights, total_tzs, status, created_at
		 FROM hotel_bookings WHERE user_id = $1 AND idempotency_key = $2`, userID, key).
		Scan(&b.ID, &b.HotelID, &b.HotelName, &b.RoomID, &b.RoomName, &b.CheckIn, &b.CheckOut,
			&b.Guests, &b.Nights, &b.TotalTZS, &b.Status, &b.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Booking{}, fmt.Errorf("hotels: booking by key: %w", ErrNotFound)
	}
	if err != nil {
		return Booking{}, fmt.Errorf("hotels: booking by key: %w", err)
	}
	return b, nil
}

// ListMyBookings returns the user's bookings, newest first (the consumer
// mock unshifts new bookings to the head).
func (s *Store) ListMyBookings(ctx context.Context, userID uuid.UUID) ([]Booking, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, hotel_id, hotel_name, room_id, room_name, check_in, check_out,
			guests, nights, total_tzs, status, created_at
		 FROM hotel_bookings WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("hotels: list my bookings: %w", err)
	}
	defer rows.Close()
	out := make([]Booking, 0, 8)
	for rows.Next() {
		var b Booking
		if err := rows.Scan(&b.ID, &b.HotelID, &b.HotelName, &b.RoomID, &b.RoomName, &b.CheckIn, &b.CheckOut,
			&b.Guests, &b.Nights, &b.TotalTZS, &b.Status, &b.CreatedAt); err != nil {
			return nil, fmt.Errorf("hotels: scan booking: %w", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("hotels: iterate bookings: %w", err)
	}
	return out, nil
}

// HotelRow is the internal row projection used by scanHotel, which also
// needs created_at for cursor pagination.
type HotelRow struct {
	Hotel
	CreatedAt time.Time
}

func scanHotel(row pgx.Row) (HotelRow, error) {
	var h HotelRow
	var amenities []byte
	var rating float64
	err := row.Scan(&h.ID, &h.Name, &h.CityID, &h.CityName, &h.StarRating, &rating,
		&h.ReviewCount, &h.StartingPriceTZS, &h.ImageURL, &amenities, &h.AddressLine,
		&h.CreatedAt)
	if err != nil {
		return h, err
	}
	h.Rating = rating
	if err := json.Unmarshal(amenities, &h.Amenities); err != nil {
		return h, fmt.Errorf("hotels: decode amenities: %w", err)
	}
	if h.Amenities == nil {
		h.Amenities = []string{}
	}
	return h, nil
}

func orNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// encodeCursor packs a row's (created_at, id) keyset into a URL-safe base64
// string; parseCursor is its inverse (the platform convention, e.g.
// bookings.go).
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("hotels: decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("hotels: cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("hotels: parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("hotels: parse cursor id: %w", err)
	}
	return createdAt, id, nil
}