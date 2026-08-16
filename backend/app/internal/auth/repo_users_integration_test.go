//go:build integration

package auth

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// TestUpdateUserProfileAndListRoles covers the users API persistence path:
// upsert → profile update → reload → role listing, plus email NULL clearing.
func TestUpdateUserProfileAndListRoles(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	phone := "+255700000010"
	userID, err := repo.UpsertUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}

	email := "neema@example.com"
	fullName := "Neema Mwangi"
	locale := "sw"
	if err := repo.UpdateUserProfile(ctx, userID, &email, &fullName, nil, locale); err != nil {
		t.Fatalf("update profile: %v", err)
	}

	u, err := repo.GetUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u == nil {
		t.Fatal("expected user after update, got nil")
	}
	if u.Email == nil || *u.Email != email {
		t.Fatalf("email = %v, want %q", u.Email, email)
	}
	if u.FullName != fullName {
		t.Fatalf("full name = %q, want %q", u.FullName, fullName)
	}
	if u.Locale != locale {
		t.Fatalf("locale = %q, want %q", u.Locale, locale)
	}

	// A nil email clears the column back to NULL.
	if err := repo.UpdateUserProfile(ctx, userID, nil, &fullName, nil, locale); err != nil {
		t.Fatalf("clear email: %v", err)
	}
	u, err = repo.GetUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("re-get user: %v", err)
	}
	if u == nil {
		t.Fatal("expected user after clear, got nil")
	}
	if u.Email != nil {
		t.Fatalf("email = %q, want NULL", *u.Email)
	}

	// No roles yet: empty list, not an error.
	roles, err := repo.ListRolesByUser(ctx, userID)
	if err != nil {
		t.Fatalf("list roles (empty): %v", err)
	}
	if len(roles) != 0 {
		t.Fatalf("roles before ensure = %d, want 0", len(roles))
	}

	if err := repo.EnsureRole(ctx, userID, "customer"); err != nil {
		t.Fatalf("ensure role: %v", err)
	}
	roles, err = repo.ListRolesByUser(ctx, userID)
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	if len(roles) != 1 {
		t.Fatalf("roles = %d, want 1", len(roles))
	}
	if roles[0].Role != "customer" {
		t.Fatalf("role = %q, want customer", roles[0].Role)
	}
	if roles[0].MerchantID != nil || roles[0].ProviderID != nil || roles[0].RiderID != nil {
		t.Fatalf("unexpected bound ids on plain role: %+v", roles[0])
	}

	// A role bound to a merchant carries the id through the scan.
	merchantID := uuid.MustParse("11111111-1111-4111-8111-111111111111")
	if _, err := pool.Exec(ctx,
		`INSERT INTO roles (user_id, role, merchant_id) VALUES ($1, 'merchant', $2)`,
		userID, merchantID); err != nil {
		t.Fatalf("insert merchant role: %v", err)
	}
	roles, err = repo.ListRolesByUser(ctx, userID)
	if err != nil {
		t.Fatalf("list roles with merchant: %v", err)
	}
	if len(roles) != 2 {
		t.Fatalf("roles = %d, want 2", len(roles))
	}
	var bound *RoleRow
	for i := range roles {
		if roles[i].Role == "merchant" {
			bound = &roles[i]
		}
	}
	if bound == nil {
		t.Fatal("merchant role missing from listing")
	}
	if bound.MerchantID == nil || *bound.MerchantID != merchantID {
		t.Fatalf("merchant id = %v, want %s", bound.MerchantID, merchantID)
	}
}

// TestListRolesByUserFiltersInactive: deactivated role rows must not be
// returned.
func TestListRolesByUserFiltersInactive(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	userID, err := repo.UpsertUserByPhone(ctx, "+255700000011")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	if err := repo.EnsureRole(ctx, userID, "customer"); err != nil {
		t.Fatalf("ensure role: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE roles SET active = false WHERE user_id = $1 AND role = 'customer'`, userID); err != nil {
		t.Fatalf("deactivate role: %v", err)
	}

	roles, err := repo.ListRolesByUser(ctx, userID)
	if err != nil {
		t.Fatalf("list roles: %v", err)
	}
	if len(roles) != 0 {
		t.Fatalf("roles = %d, want 0 when inactive", len(roles))
	}
}
