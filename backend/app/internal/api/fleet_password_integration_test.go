//go:build integration

// FLEET-ACCOUNTS and AUTH CHANGE-PASSWORD integration tests against real
// PostgreSQL + Redis (migration 00049).
//
//	cd app && go test -tags integration ./internal/api/ -run 'FleetAccount|ChangePassword' -count=1
//
// This suite owns only its own rows: users (phone prefix +255982...) and the
// fleet_accounts rows that cascade from them (ON DELETE CASCADE). It never
// truncates shared tables.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// fleetPhonePrefix identifies every users row this suite inserts.
const fleetPhonePrefix = "+255982"

// fleetSetup wires a persistent server and clears this suite's own rows:
// users by phone prefix, cascading to their fleet_accounts rows.
func fleetSetup(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	s, pool := newPersistentServer(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE phone LIKE '`+fleetPhonePrefix+`%'`); err != nil {
		t.Fatalf("clear fleet users: %v", err)
	}
	return s, pool
}

// fleetUser inserts one users row owned by this suite and returns its id and
// a session token for it. The row (and its cascading fleet_accounts rows) is
// deleted when the test finishes, so even a failing test leaves no residue.
func fleetUser(t *testing.T, pool *pgxpool.Pool, s *Server, tag string) (uuid.UUID, string) {
	t.Helper()
	phone := fmt.Sprintf("%s%08d", fleetPhonePrefix, time.Now().UnixNano()%100_000_000)
	userID := uuid.New()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, userID, phone); err != nil {
		t.Fatalf("insert fleet user: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(),
			`DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("cleanup fleet user: %v", err)
		}
	})
	return userID, tokenFor(t, s, phone, RoleRider, false)
}

// TestFleetAccountsCreateListConflict exercises the /fleet/accounts surface:
// create → 201, list → contains it, a second create for the same owner → 409.
func TestFleetAccountsCreateListConflict(t *testing.T) {
	s, pool := fleetSetup(t)
	h := s.Router()
	_, token := fleetUser(t, pool, s, "owner")

	rec := authedRequest(t, h, http.MethodPost, "/fleet/accounts", token,
		`{"name":"Metro Riders","status":"active","vehicles":["00000000-0000-4000-8000-000000000001"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, want 201 (%s)", rec.Code, rec.Body)
	}
	var created gen.FleetAccount
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.Name != "Metro Riders" || created.Status != gen.FleetAccountStatusActive {
		t.Fatalf("created = %+v", created)
	}

	rec = authedRequest(t, h, http.MethodGet, "/fleet/accounts", token, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var list []gen.FleetAccount
	if err := json.NewDecoder(rec.Body).Decode(&list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	found := false
	for _, a := range list {
		if a.Id == created.Id && a.Name == "Metro Riders" {
			found = true
		}
	}
	if !found {
		t.Fatalf("created account missing from list: %+v", list)
	}

	rec = authedRequest(t, h, http.MethodPost, "/fleet/accounts", token,
		`{"name":"Second Fleet"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, want 409 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode duplicate error: %v", err)
	}
	if errBody.Code != "CONFLICT" {
		t.Fatalf("duplicate error code = %q, want CONFLICT", errBody.Code)
	}

	// Staff sessions see every account.
	staffToken := tokenFor(t, s, fleetPhonePrefix+"00000001", RoleAdmin, true)
	rec = authedRequest(t, h, http.MethodGet, "/fleet/accounts", staffToken, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("staff list status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var staffList []gen.FleetAccount
	if err := json.NewDecoder(rec.Body).Decode(&staffList); err != nil {
		t.Fatalf("decode staff list: %v", err)
	}
	found = false
	for _, a := range staffList {
		if a.Id == created.Id {
			found = true
		}
	}
	if !found {
		t.Fatalf("staff list missing account: %+v", staffList)
	}
}

// TestChangePasswordWithoutHash: an OTP-only account (password_hash NULL)
// cannot change a password → 422 PASSWORD_CHANGE_INVALID.
func TestChangePasswordWithoutHash(t *testing.T) {
	s, pool := fleetSetup(t)
	h := s.Router()
	_, token := fleetUser(t, pool, s, "otp")

	rec := authedRequest(t, h, http.MethodPost, "/auth/change-password", token,
		`{"currentPassword":"old-pass","newPassword":"new-pass-123"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errBody.Code != "PASSWORD_CHANGE_INVALID" {
		t.Fatalf("error code = %q, want PASSWORD_CHANGE_INVALID", errBody.Code)
	}
}

// TestChangePasswordWrongCurrent: with a seeded sha256$salt$hash, the wrong
// current password is rejected with 401 PASSWORD_CHANGE_INVALID.
func TestChangePasswordWrongCurrent(t *testing.T) {
	s, pool := fleetSetup(t)
	h := s.Router()
	userID, token := fleetUser(t, pool, s, "wrong")

	seed, err := hashPassword("correct-horse")
	if err != nil {
		t.Fatalf("seed hash: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE users SET password_hash = $1 WHERE id = $2`, seed, userID); err != nil {
		t.Fatalf("seed password hash: %v", err)
	}

	rec := authedRequest(t, h, http.MethodPost, "/auth/change-password", token,
		`{"currentPassword":"wrong-password","newPassword":"new-pass-123"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errBody.Code != "PASSWORD_CHANGE_INVALID" {
		t.Fatalf("error code = %q, want PASSWORD_CHANGE_INVALID", errBody.Code)
	}
}

// TestChangePasswordSuccess: with a seeded hash, the correct current password
// swaps the hash (204); the stored hash then verifies the new password and
// rejects the old one.
func TestChangePasswordSuccess(t *testing.T) {
	s, pool := fleetSetup(t)
	h := s.Router()
	userID, token := fleetUser(t, pool, s, "swap")

	seed, err := hashPassword("correct-horse")
	if err != nil {
		t.Fatalf("seed hash: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE users SET password_hash = $1 WHERE id = $2`, seed, userID); err != nil {
		t.Fatalf("seed password hash: %v", err)
	}

	rec := authedRequest(t, h, http.MethodPost, "/auth/change-password", token,
		`{"currentPassword":"correct-horse","newPassword":"new-pass-123"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	var stored string
	if err := pool.QueryRow(context.Background(),
		`SELECT password_hash FROM users WHERE id = $1`, userID).Scan(&stored); err != nil {
		t.Fatalf("read password hash: %v", err)
	}
	if !strings.HasPrefix(stored, passwordHashPrefix) {
		t.Fatalf("stored hash %q does not use the %s scheme", stored, passwordHashPrefix)
	}
	if !verifyPassword(stored, "new-pass-123") {
		t.Fatal("stored hash does not verify the new password")
	}
	if verifyPassword(stored, "correct-horse") {
		t.Fatal("stored hash still verifies the old password")
	}
}

// TestChangePasswordTooShort: newPassword under the 8-character contract
// minimum is rejected with 422 PASSWORD_CHANGE_INVALID.
func TestChangePasswordTooShort(t *testing.T) {
	s, pool := fleetSetup(t)
	h := s.Router()
	userID, token := fleetUser(t, pool, s, "short")

	seed, err := hashPassword("correct-horse")
	if err != nil {
		t.Fatalf("seed hash: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE users SET password_hash = $1 WHERE id = $2`, seed, userID); err != nil {
		t.Fatalf("seed password hash: %v", err)
	}

	rec := authedRequest(t, h, http.MethodPost, "/auth/change-password", token,
		`{"currentPassword":"correct-horse","newPassword":"short"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if errBody.Code != "PASSWORD_CHANGE_INVALID" {
		t.Fatalf("error code = %q, want PASSWORD_CHANGE_INVALID", errBody.Code)
	}
}
