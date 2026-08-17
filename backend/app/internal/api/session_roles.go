package api

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/auth"
	"github.com/hudumika/api-backend/internal/gen"
)

// rolePermissionSets derives a static, honest capability set per role. The
// merchant app consumes Session.me.permissions; '*' means full access to that
// role's surface. The derivation is static (no stored permission table exists
// yet): a role's permissions mirror the surfaces its routePolicy entries and
// domain handlers allow. Re-check whenever routePolicy changes.
var rolePermissionSets = map[string][]string{
	RoleCustomer:   {"orders:place", "orders:track", "wallet:manage", "loyalty:view", "bookings:manage", "profile:manage"},
	RoleMerchant:   {"merchants:manage", "catalogue:manage", "orders:fulfill", "wallet:manage", "payouts:manage", "staff:manage", "dinein:manage"},
	RoleProvider:   {"providers:manage", "services:fulfill", "wallet:manage", "payouts:manage", "schedule:manage"},
	RoleRider:      {"riders:manage", "deliveries:claim", "wallet:manage", "payouts:manage", "route:manage"},
	RoleAdmin:      {"admin:*", "finance:*", "ops:*", "compliance:*"},
	RoleFinance:    {"finance:*", "admin:view"},
	RoleOps:        {"ops:*", "admin:view"},
	RoleCompliance: {"compliance:*", "admin:view"},
}

// requestedRole resolves the verify-request role to a canonical role. An
// empty value defaults to customer (the historical behavior). Staff roles
// (admin, finance, ops, compliance) are requestable at login; their sessions
// start with mfa_verified=false and must pass 2FA before /admin/* access.
func requestedRole(role string) (string, bool) {
	switch role {
	case "", RoleCustomer:
		return RoleCustomer, true
	case RoleMerchant, RoleProvider, RoleRider, RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		return role, true
	default:
		return "", false
	}
}

// staffRole reports whether the role is a staff role. Staff sessions always
// start unverified (mfa_verified=false in the Claims) and the route policy
// demands verification for /admin/*.
func staffRole(role string) bool {
	switch role {
	case RoleAdmin, RoleFinance, RoleOps, RoleCompliance:
		return true
	}
	return false
}

// mintRoleSession issues a role-scoped session: the token pair via
// buildSession (whose Claims carry the role; staff sessions start with
// mfa_verified=false) persisted through the session store and the durable
// auth session table when a repo is attached. userID is the verified user
// (from the auth service); it may be uuid.Nil when the DB-less dev server is
// used. It mirrors VerifyOtp's store wiring so both flows stay identical.
func (s *Server) mintRoleSession(ctx context.Context, subject, role string, userID uuid.UUID, now time.Time) (gen.Session, error) {
	session, err := s.buildSession(ctx, subject, role, now)
	if err != nil {
		return gen.Session{}, err
	}
	if err := s.stores.Sessions.Create(ctx, session.record); err != nil {
		return gen.Session{}, err
	}
	if s.auth != nil {
		if err := s.auth.PersistSession(ctx, auth.SessionRow{
			UserID:           userID,
			Role:             role,
			AccessTokenHash:  session.record.AccessTokenHash,
			RefreshTokenHash: session.record.RefreshTokenHash,
			ExpiresAt:        session.record.ExpiresAt,
		}); err != nil {
			return gen.Session{}, err
		}
	}
	return session.session, nil
}

// writeRoleNotActive responds 422 ROLE_NOT_ACTIVE (contract: a role with no
// active role row).
func writeRoleNotActive(w http.ResponseWriter, role string) {
	writeError(w, http.StatusUnprocessableEntity, "ROLE_NOT_ACTIVE", "No active "+role+" role for this account")
}
