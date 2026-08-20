// Package riders is the bounded context for rider applications, profiles
// and the online flag that dispatch reads. It talks directly to PostgreSQL
// via a pgxpool.Pool; volatile online/location state lives in Redis
// (online.go).
package riders

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrAlreadyApplied is returned by Apply when the user already owns a rider
// row (the riders table has a unique constraint on owner_user_id).
var ErrAlreadyApplied = errors.New("riders: user already applied")

// Rider is the projection of one riders row used by the API layer.
type Rider struct {
	ID           uuid.UUID
	Name         string
	CityID       string
	Vehicle      string
	Verification string
	Online       bool
	Rating       *float64
	ReviewCount  *int
}

// Store wraps the connection pool for all rider persistence.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore returns a Store bound to the given pool.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// Apply inserts a rider application for the user. A user may apply exactly
// once: a second application for the same owner_user_id yields
// ErrAlreadyApplied. The returned id is the new riders row.
func (s *Store) Apply(ctx context.Context, userID uuid.UUID, name, cityID, vehicle string) (uuid.UUID, error) {
	var id uuid.UUID
	err := s.pool.QueryRow(ctx,
		`INSERT INTO riders (owner_user_id, name, city_id, vehicle)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (owner_user_id) DO NOTHING
		 RETURNING id`,
		userID, name, cityID, vehicle).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrAlreadyApplied
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("riders: apply for user %s: %w", userID, err)
	}
	return id, nil
}

// GetByOwner returns the rider owned by the user, or (nil, nil) when the
// user has no rider row.
func (s *Store) GetByOwner(ctx context.Context, userID uuid.UUID) (*Rider, error) {
	var r Rider
	var cityID *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, city_id, vehicle, verification, online, rating, review_count
		 FROM riders WHERE owner_user_id = $1`,
		userID).Scan(&r.ID, &r.Name, &cityID, &r.Vehicle, &r.Verification, &r.Online, &r.Rating, &r.ReviewCount)
	if cityID != nil {
		r.CityID = *cityID
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("riders: get by owner %s: %w", userID, err)
	}
	return &r, nil
}

// GetRider returns the rider row by id, or (nil, nil) when no such rider
// exists. Dispatch uses it to verify a manual-override target.
func (s *Store) GetRider(ctx context.Context, riderID uuid.UUID) (*Rider, error) {
	var r Rider
	var cityID *string
	err := s.pool.QueryRow(ctx,
		`SELECT id, name, city_id, vehicle, verification, online, rating, review_count
		 FROM riders WHERE id = $1`,
		riderID).Scan(&r.ID, &r.Name, &cityID, &r.Vehicle, &r.Verification, &r.Online, &r.Rating, &r.ReviewCount)
	if cityID != nil {
		r.CityID = *cityID
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("riders: get rider %s: %w", riderID, err)
	}
	return &r, nil
}

// UpdateProfile writes the mutable profile fields of a rider.
func (s *Store) UpdateProfile(ctx context.Context, riderID uuid.UUID, name, vehicle string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE riders SET name = $2, vehicle = $3, updated_at = now() WHERE id = $1`,
		riderID, name, vehicle)
	if err != nil {
		return fmt.Errorf("riders: update profile %s: %w", riderID, err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("riders: update profile %s: %w", riderID, pgx.ErrNoRows)
	}
	return nil
}

// SetOnline flips the dispatch online flag. The volatile Redis membership
// (OnlineRegistry) is kept in sync by the caller.
func (s *Store) SetOnline(ctx context.Context, riderID uuid.UUID, online bool) error {
	if _, err := s.pool.Exec(ctx,
		`UPDATE riders SET online = $2, updated_at = now() WHERE id = $1`,
		riderID, online); err != nil {
		return fmt.Errorf("riders: set online %s: %w", riderID, err)
	}
	return nil
}

// CountOnline returns the number of riders currently flagged online.
func (s *Store) CountOnline(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM riders WHERE online`).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("riders: count online: %w", err)
	}
	return n, nil
}
