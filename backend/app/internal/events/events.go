// Package events is the bounded context for the entertainment events
// vertical (CONTRACT-ADDITIONS.md "Entertainment events — /entertainment
// resource"). It talks directly to PostgreSQL via a pgxpool.Pool. Ticket
// totals are always computed server-side from the tier price; clients never
// supply money. Purchases are idempotent per key (PAYMENTS.md idempotency
// rule): a replay returns the originally issued tickets without touching
// remaining counts again.
package events

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"math/rand"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Sentinel errors surfaced to the API layer.
var (
	ErrNotFound          = errors.New("events: not found")
	ErrInvalidCursor     = errors.New("events: invalid pagination cursor")
	ErrIdempotencyReplay = errors.New("events: idempotency replay")
	ErrSoldOut           = errors.New("events: not enough tickets left in this tier")
)

// Store wraps the connection pool for all events persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Event is the projection of an events row for the listing (contract
// EventListing schema).
type Event struct {
	ID               uuid.UUID
	Title            string
	Category         *string
	CityID           string
	CityName         string
	Venue            *string
	StartsAt         time.Time
	ImageURL         string
	Description      *string
	StartingPriceTZS int
	CreatedAt        time.Time
}

// Tier is one event_tiers row (contract EventTier schema).
type Tier struct {
	ID        uuid.UUID
	Name      string
	PriceTZS  int
	Available bool
	Remaining *int
}

// Ticket is one event_tickets row (contract EventTicket schema).
type Ticket struct {
	ID         uuid.UUID
	EventID    uuid.UUID
	EventTitle string
	Venue      *string
	StartsAt   *time.Time
	TierName   string
	PriceTZS   int
	Code       string
	Status     string
	CreatedAt  time.Time
}

// PurchaseInput is the input shape for a ticket purchase.
type PurchaseInput struct {
	UserID         uuid.UUID
	EventID        uuid.UUID
	TierID         uuid.UUID
	Quantity       int
	IdempotencyKey string
}

const eventColumns = `id, title, category, city_id, city_name, venue, starts_at, image_url, created_at`

// eventColumnsDetail is the event projection including the description
// snapshot (the detail shape; the listing omits it).
const eventColumnsDetail = `id, title, category, city_id, city_name, venue, starts_at, image_url, description, created_at`

// ListEvents returns events oldest-first, keyset-paginated on (created_at,
// id) with optional cityId/category filters. next is the base64 cursor of the
// last returned row when another page exists, else "".
func (s *Store) ListEvents(ctx context.Context, cityID, category string, limit int, cursor string) ([]Event, string, error) {
	query := `SELECT ` + eventColumns + ` FROM events`
	args := make([]any, 0, 4)
	var conds []string
	if cityID != "" {
		args = append(args, cityID)
		conds = append(conds, fmt.Sprintf("city_id = $%d", len(args)))
	}
	if category != "" {
		args = append(args, category)
		conds = append(conds, fmt.Sprintf("category = $%d", len(args)))
	}
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	if cursor != "" {
		at, id, err := parseCursor(cursor)
		if err != nil {
			return nil, "", fmt.Errorf("events: list events: %w", ErrInvalidCursor)
		}
		args = append(args, at, id)
		query += fmt.Sprintf(" AND (created_at, id) > ($%d, $%d)", len(args)-1, len(args))
	}
	args = append(args, limit+1)
	query += fmt.Sprintf(" ORDER BY created_at, id LIMIT $%d", len(args))

	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, "", fmt.Errorf("events: list events: %w", err)
	}
	defer rows.Close()

	out := make([]Event, 0, limit)
	var (
		last     Event
		sentinel bool
	)
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.ID, &e.Title, &e.Category, &e.CityID, &e.CityName, &e.Venue,
			&e.StartsAt, &e.ImageURL, &e.CreatedAt); err != nil {
			return nil, "", fmt.Errorf("events: scan event: %w", err)
		}
		if len(out) == limit {
			sentinel = true
			continue
		}
		out = append(out, e)
		last = e
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("events: iterate events: %w", err)
	}
	next := ""
	if sentinel {
		next = encodeCursor(last.CreatedAt, last.ID)
	}
	return out, next, nil
}

// GetEvent loads an event and its tiers; ErrNotFound when absent. The
// starting price is derived server-side as the cheapest tier price.
func (s *Store) GetEvent(ctx context.Context, eventID uuid.UUID) (*Event, []Tier, error) {
	var e Event
	err := s.pool.QueryRow(ctx,
		`SELECT `+eventColumnsDetail+` FROM events WHERE id = $1`, eventID).
		Scan(&e.ID, &e.Title, &e.Category, &e.CityID, &e.CityName, &e.Venue,
			&e.StartsAt, &e.ImageURL, &e.Description, &e.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, fmt.Errorf("events: get event %s: %w", eventID, ErrNotFound)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("events: get event %s: %w", eventID, err)
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, name, price_tzs, available, remaining FROM event_tiers
		 WHERE event_id = $1 ORDER BY price_tzs`, eventID)
	if err != nil {
		return nil, nil, fmt.Errorf("events: list tiers %s: %w", eventID, err)
	}
	defer rows.Close()

	tiers := make([]Tier, 0, 4)
	minPrice := -1
	for rows.Next() {
		var t Tier
		if err := rows.Scan(&t.ID, &t.Name, &t.PriceTZS, &t.Available, &t.Remaining); err != nil {
			return nil, nil, fmt.Errorf("events: scan tier: %w", err)
		}
		if minPrice < 0 || t.PriceTZS < minPrice {
			minPrice = t.PriceTZS
		}
		tiers = append(tiers, t)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("events: iterate tiers: %w", err)
	}
	if minPrice < 0 {
		minPrice = 0
	}
	e.StartingPriceTZS = minPrice
	return &e, tiers, nil
}

// PurchaseTickets issues tickets for a tier. The row lock on the tier
// guards the remaining count (a concurrent purchase cannot oversell), the
// event's sold_count is bumped in the same transaction, and every ticket
// carries the EV-XXXX code the contract specifies. A duplicate idempotency
// key replays the issued tickets (ErrIdempotencyReplay carries them).
// ErrSoldOut rejects purchases beyond the tier's remaining count.
func (s *Store) PurchaseTickets(ctx context.Context, in PurchaseInput) ([]Ticket, error) {
	replayed, err := s.TicketsByKey(ctx, in.UserID, in.IdempotencyKey)
	if err == nil {
		return replayed, fmt.Errorf("events: purchase tickets: %w", ErrIdempotencyReplay)
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("events: begin purchase tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		eventTitle string
		venue      *string
		startsAt   *time.Time
		tierName   string
		tierPrice  int
		remaining  int
		available  bool
	)
	err = tx.QueryRow(ctx,
		`SELECT e.title, e.venue, e.starts_at, t.name, t.price_tzs, t.remaining, t.available
		 FROM event_tiers t JOIN events e ON e.id = t.event_id
		 WHERE t.id = $1 AND t.event_id = $2 FOR UPDATE OF t`, in.TierID, in.EventID).
		Scan(&eventTitle, &venue, &startsAt, &tierName, &tierPrice, &remaining, &available)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("events: purchase tickets: %w", ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("events: load tier %s: %w", in.TierID, err)
	}
	if !available || remaining < in.Quantity {
		return nil, fmt.Errorf("events: purchase tickets: %w", ErrSoldOut)
	}

	issued := make([]Ticket, 0, in.Quantity)
	codeSet := make(map[string]struct{}, in.Quantity)
	for i := 0; i < in.Quantity; i++ {
		code := ticketCode()
		for {
			if _, dup := codeSet[code]; !dup {
				break
			}
			code = ticketCode()
		}
		codeSet[code] = struct{}{}
		var t Ticket
		err := tx.QueryRow(ctx,
			`INSERT INTO event_tickets (event_id, user_id, code, tier_name, price_tzs, qty,
				total_tzs, event_title, venue, starts_at, status, idempotency_key)
			 VALUES ($1, $2, $3, $4, $5, 1, $5, $6, $7, $8, 'active', $9)
			 RETURNING id, event_id, event_title, venue, starts_at, tier_name, price_tzs,
				code, status, created_at`,
			in.EventID, in.UserID, code, tierName, tierPrice, eventTitle, venue, startsAt,
			orNull(in.IdempotencyKey)).
			Scan(&t.ID, &t.EventID, &t.EventTitle, &t.Venue, &t.StartsAt, &t.TierName,
				&t.PriceTZS, &t.Code, &t.Status, &t.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("events: insert ticket: %w", err)
		}
		issued = append(issued, t)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE event_tiers SET remaining = remaining - $1, available = remaining - $1 > 0
		 WHERE id = $2`, in.Quantity, in.TierID); err != nil {
		return nil, fmt.Errorf("events: decrement tier remaining: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`UPDATE events SET sold_count = sold_count + $1 WHERE id = $2`, in.Quantity, in.EventID); err != nil {
		return nil, fmt.Errorf("events: bump sold count: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("events: commit purchase: %w", err)
	}
	return issued, nil
}

// TicketsByKey loads a user's tickets by their idempotency key (all tickets
// issued in one purchase share the key); ErrNotFound when absent.
func (s *Store) TicketsByKey(ctx context.Context, userID uuid.UUID, key string) ([]Ticket, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, event_id, event_title, venue, starts_at, tier_name, price_tzs,
			code, status, created_at
		 FROM event_tickets WHERE user_id = $1 AND idempotency_key = $2
		 ORDER BY created_at, id`, userID, key)
	if err != nil {
		return nil, fmt.Errorf("events: tickets by key: %w", err)
	}
	defer rows.Close()
	out := make([]Ticket, 0, 4)
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.EventID, &t.EventTitle, &t.Venue, &t.StartsAt, &t.TierName,
			&t.PriceTZS, &t.Code, &t.Status, &t.CreatedAt); err != nil {
			return nil, fmt.Errorf("events: scan ticket: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("events: iterate tickets: %w", err)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("events: tickets by key: %w", ErrNotFound)
	}
	return out, nil
}

// ListMyTickets returns the user's tickets, newest first (the consumer mock
// unshifts newly purchased tickets to the head).
func (s *Store) ListMyTickets(ctx context.Context, userID uuid.UUID) ([]Ticket, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, event_id, event_title, venue, starts_at, tier_name, price_tzs,
			code, status, created_at
		 FROM event_tickets WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, userID)
	if err != nil {
		return nil, fmt.Errorf("events: list my tickets: %w", err)
	}
	defer rows.Close()
	out := make([]Ticket, 0, 8)
	for rows.Next() {
		var t Ticket
		if err := rows.Scan(&t.ID, &t.EventID, &t.EventTitle, &t.Venue, &t.StartsAt, &t.TierName,
			&t.PriceTZS, &t.Code, &t.Status, &t.CreatedAt); err != nil {
			return nil, fmt.Errorf("events: scan ticket: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("events: iterate tickets: %w", err)
	}
	return out, nil
}

// ticketCode mints an EV-XXXX code (EVENT-TICKETS.md; EventTicket.code) from
// the same unambiguous alphabet the consumer mock uses.
func ticketCode() string {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	b := make([]byte, 4)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return "EV-" + string(b)
}

func orNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// encodeCursor packs a row's (created_at, id) keyset into a URL-safe base64
// string; parseCursor is its inverse (the platform convention).
func encodeCursor(createdAt time.Time, id uuid.UUID) string {
	raw := createdAt.UTC().Format(time.RFC3339Nano) + "|" + id.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func parseCursor(cursor string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("events: decode cursor: %w", err)
	}
	sep := strings.LastIndexByte(string(raw), '|')
	if sep < 0 {
		return time.Time{}, uuid.Nil, fmt.Errorf("events: cursor separator missing")
	}
	createdAt, err := time.Parse(time.RFC3339Nano, string(raw[:sep]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("events: parse cursor timestamp: %w", err)
	}
	id, err := uuid.Parse(string(raw[sep+1:]))
	if err != nil {
		return time.Time{}, uuid.Nil, fmt.Errorf("events: parse cursor id: %w", err)
	}
	return createdAt, id, nil
}