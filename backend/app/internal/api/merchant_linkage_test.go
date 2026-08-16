//go:build integration

package api

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// seedMerchantRow inserts a merchants row owned by the given user and
// returns the merchants row id. Merchant-scoped tables reference the REAL
// merchants row id (merchant_linkage.go), so integration tests that exercise
// merchant-gated handlers must seed the merchants row and scope their rows
// by its id — never by the owner's users id.
func seedMerchantRow(t *testing.T, pool *pgxpool.Pool, ownerUserID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO merchants (owner_user_id, business_name)
		 VALUES ($1, 'Test Merchant') RETURNING id`, ownerUserID).Scan(&id); err != nil {
		t.Fatalf("seed merchants row for %s: %v", ownerUserID, err)
	}
	return id
}
