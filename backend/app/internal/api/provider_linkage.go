package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/auth"
)

// PROVIDER LINKAGE: every provider-scoped row (bookings.provider_id,
// provider_services.*, provider_technicians/staff/certifications/inventory/
// plans/documents, provider_availability, service_contracts) must reference
// the real providers row (DATA-MODEL §marketplaces: providers rows created
// by ApplyProvider, linked to users via owner_user_id).
//
// Rows written before the linkage refactor used the provider owner's USERS
// id as the entity id (the old "user-id-as-entity" convention). The
// resolvers in this file translate both directions:
//
//   - providerIDForSession / providerIDForUser answer "which providers row
//     does this session/user own?" for every provider-gated write path, so
//     writes always store the real providers row id.
//   - resolveProviderID maps a client-supplied reference (which may be the
//     legacy users id or the real providers id) onto the real providers
//     row id.
//   - providerBookingOwned accepts both conventions on reads: a booking
//     carrying the real providers id (new rows) or the legacy users id
//     (pre-linkage rows).
//
// errNoProvider is the sentinel for "the user owns no providers row".
var errNoProvider = errors.New("api: no providers row for session")

// providerIDForUser resolves the providers row owned by the users row id,
// or errNoProvider when the user has no providers row.
func (s *Server) providerIDForUser(ctx context.Context, userID uuid.UUID) (uuid.UUID, error) {
	if s.db == nil {
		return uuid.Nil, errNoDatabase
	}
	p, err := s.merchantStore().GetProviderByOwner(ctx, userID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("provider linkage: resolve provider for user %s: %w", userID, err)
	}
	if p == nil {
		return uuid.Nil, errNoProvider
	}
	return p.ID, nil
}

// providerIDForSession resolves the authenticated session to its providers
// row id (claims.Subject -> users.id -> GetProviderByOwner -> providers.id).
// A session without a providers row yields errNoProvider.
func (s *Server) providerIDForSession(r *http.Request) (uuid.UUID, error) {
	if s.db == nil {
		return uuid.Nil, errNoDatabase
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims.Subject == "" {
		return uuid.Nil, errNoBearerToken
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return uuid.Nil, fmt.Errorf("provider linkage: resolve session user: %w", err)
	}
	if user == nil {
		return uuid.Nil, errUserNotFound
	}
	return s.providerIDForUser(r.Context(), user.ID)
}

// resolveProviderID maps a client-supplied provider reference onto a real
// providers row id. A raw id that is not itself a providers row is accepted
// when it is the providers.owner_user_id of some row (legacy references);
// an unknown id errors — the caller answers 404 BOOKING_PROVIDER_UNAVAILABLE.
func resolveProviderID(ctx context.Context, pool *pgxpool.Pool, raw uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx,
		`SELECT id FROM providers WHERE id = $1 OR owner_user_id = $1 LIMIT 1`, raw).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("provider linkage: no providers row for %s", raw)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("provider linkage: resolve provider %s: %w", raw, err)
	}
	return id, nil
}

// providerBookingOwned reports whether the session may act on a booking as
// its provider. New bookings store the real providers row id; legacy rows
// (pre-linkage) store the provider owner's users id, so both match. A
// session without a providers row never matches.
func (s *Server) providerBookingOwned(ctx context.Context, actor uuid.UUID, bookingProviderID uuid.UUID) (bool, error) {
	providerID, err := s.providerIDForUser(ctx, actor)
	if errors.Is(err, errNoProvider) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return bookingProviderID == providerID || bookingProviderID == actor, nil
}
