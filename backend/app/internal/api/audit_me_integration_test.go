//go:build integration

// AUDIT-ME integration tests against real PostgreSQL + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'MyAudit' -count=1
//
// audit_logs rows seeded here use explicit per-run ids and are deleted at
// cleanup; the suite never truncates the log.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// auditMeSetup wires a persistent server and waits for the orders table.
func auditMeSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	waitForOrdersTable(t, pool)
	return s, pool
}

// auditMeSeed inserts one audit_logs row with an explicit id and registers
// cleanup by id.
func auditMeSeed(t *testing.T, pool *pgxpool.Pool, actorID uuid.UUID, role, action, entityType string) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, request_id, created_at)
		 VALUES ($1, $2, $3, $4, $5, 'entity-1', 'req-1', $6)`,
		id, actorID, role, action, entityType, time.Now().UTC()); err != nil {
		t.Fatalf("insert audit log row: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM audit_logs WHERE id = $1`, id) })
	return id
}

// TestGetMyAuditLogIntegration: the session user's entries are returned by
// actor_id; a phone-subject row (actor_id = nil UUID, the audit middleware's
// mapping) is NOT attributed, and a user without entries gets [].
func TestGetMyAuditLogIntegration(t *testing.T) {
	s, pool := auditMeSetup(t)
	userID, userPhone := assistantSeedUser(t, pool)
	otherID, _ := assistantSeedUser(t, pool)

	// Entries attributable to the session user by actor_id.
	seedID := auditMeSeed(t, pool, userID, "merchant", "POST /orders/123/accept", "orders")
	auditMeSeed(t, pool, otherID, "merchant", "POST /orders/456/accept", "orders")
	// Phone-subject row: the middleware maps the phone to the nil UUID
	// (internal/audit/audit.go actorUUID); it must not leak to any user.
	auditMeSeed(t, pool, uuid.Nil, "merchant", "POST /orders/789/accept", "orders")

	token := tokenFor(t, s, userPhone, RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/audit/me", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var got []struct {
		Id          string `json:"id"`
		ActorUserId string `json:"actorUserId"`
		Action      string `json:"action"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("entries = %d, want 1 (%s)", len(got), rec.Body)
	}
	if got[0].Id != seedID.String() {
		t.Fatalf("unexpected entry id %s, want %s", got[0].Id, seedID)
	}
}

// TestGetMyAuditLogEmpty: a user with no attributable entries gets [] (200),
// never an error.
func TestGetMyAuditLogEmpty(t *testing.T) {
	s, _ := auditMeSetup(t)
	token := tokenFor(t, s, "+255700000301", RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/audit/me", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := rec.Body.String(); !containsJSONArray(got) {
		t.Fatalf("expected [], got %s", got)
	}
}

// containsJSONArray reports whether the body decodes as an empty JSON array.
func containsJSONArray(body string) bool {
	var arr []json.RawMessage
	return json.Unmarshal([]byte(body), &arr) == nil && len(arr) == 0
}
