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

// MERCHANT LINKAGE: every merchant-scoped row (orders.merchant_id,
// catalogue_items.merchant_id, group_buy_deals.merchant_id,
// dine_in_tables/orders/reservations.merchant_id, loyalty_members.merchant_id,
// promotions/coupon_campaigns.merchant_id, voucher_verifications.merchant_id)
// must reference the real merchants row (DATA-MODEL §marketplaces: merchants
// rows created by ApplyMerchant, linked to users via owner_user_id).
//
// Rows written before the linkage refactor used the merchant owner's USERS
// id as the entity id (the old "user-id-as-entity" convention). The
// resolvers in this file translate both directions:
//
//   - merchantIDForSession / merchantIDForUser answer "which merchants row
//     does this session/user own?" for every merchant-gated write path, so
//     writes always store the real merchants row id.
//   - resolveMerchantID maps a client-supplied or stored reference (which
//     may be the legacy users id or the real merchants id) onto the real
//     merchants row id.
//   - merchantRowOwned accepts both conventions on reads: a row carrying
//     the real merchants id (new rows) or the legacy users id (pre-linkage
//     rows) matches the session merchant.
//
// errNoMerchant is the sentinel for "the user owns no merchants row".
var errNoMerchant = errors.New("api: no merchants row for session")

// merchantIDForUser resolves the merchants row owned by the users row id,
// or errNoMerchant when the user has no merchants row.
func (s *Server) merchantIDForUser(ctx context.Context, userID uuid.UUID) (uuid.UUID, error) {
	if s.db == nil {
		return uuid.Nil, errNoDatabase
	}
	m, err := s.merchantStore().GetMerchantByOwner(ctx, userID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("merchant linkage: resolve merchant for user %s: %w", userID, err)
	}
	if m == nil {
		return uuid.Nil, errNoMerchant
	}
	return m.ID, nil
}

// merchantIDForSession resolves the authenticated session to its merchants
// row id (claims.Subject -> users.id -> GetMerchantByOwner -> merchants.id).
// Staff sessions resolve to the nil uuid meaning "unscoped" (the dine-in
// staff listing convention); a session without a merchants row yields
// errNoMerchant.
func (s *Server) merchantIDForSession(r *http.Request) (uuid.UUID, error) {
	if s.db == nil {
		return uuid.Nil, errNoDatabase
	}
	claims, ok := ClaimsFromContext(r.Context())
	if !ok || claims.Subject == "" {
		return uuid.Nil, errNoBearerToken
	}
	if isStaffRole(claims.Role) {
		return uuid.Nil, nil
	}
	user, err := auth.NewRepo(s.db.Pool()).GetUserByPhone(r.Context(), claims.Subject)
	if err != nil {
		return uuid.Nil, fmt.Errorf("merchant linkage: resolve session user: %w", err)
	}
	if user == nil {
		return uuid.Nil, errUserNotFound
	}
	return s.merchantIDForUser(r.Context(), user.ID)
}

// resolveMerchantID maps a client-supplied or stored merchant reference onto
// a real merchants row id. A raw id that is not itself a merchants row is
// accepted when it is the merchants.owner_user_id of some row (legacy
// references written before the linkage refactor); an unknown id errors —
// the caller answers 404. This shared predicate is the documented backward
// compatibility for EXISTING rows whose merchant_id holds the old users id.
func resolveMerchantID(ctx context.Context, pool *pgxpool.Pool, raw uuid.UUID) (uuid.UUID, error) {
	var id uuid.UUID
	err := pool.QueryRow(ctx,
		`SELECT id FROM merchants WHERE id = $1 OR owner_user_id = $1 LIMIT 1`, raw).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, fmt.Errorf("merchant linkage: no merchants row for %s", raw)
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("merchant linkage: resolve merchant %s: %w", raw, err)
	}
	return id, nil
}

// merchantRowOwned reports whether a row's stored merchant reference
// (rowMerchantID, which may be the real merchants id or the legacy owner's
// users id) belongs to the session merchant (merchantID). A nil merchantID
// (staff/unscoped) always matches; an unresolvable reference never does.
func (s *Server) merchantRowOwned(ctx context.Context, merchantID, rowMerchantID uuid.UUID) (bool, error) {
	if merchantID == uuid.Nil {
		return true, nil
	}
	if rowMerchantID == merchantID {
		return true, nil
	}
	resolved, err := resolveMerchantID(ctx, s.db.Pool(), rowMerchantID)
	if err != nil {
		return false, nil
	}
	return resolved == merchantID, nil
}
