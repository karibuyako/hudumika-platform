//go:build integration

// PUSH-TOKEN registry integration tests against real PostgreSQL + Redis
// (migration 00059_push_tokens.sql).
//
//	cd app && DATABASE_URL=... REDIS_URL=... go test -tags integration ./internal/api/ -run 'PushToken' -count=1
//
// This suite owns only the rows it inserts: its own push_tokens rows and its
// own users (phone prefix +255946). It never truncates. Validation ordering:
// RegisterPushToken validates the body before resolving the caller, so an
// invalid platform answers 422 PUSH_TOKEN_INVALID even with a healthy
// database.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// pushTokenPhonePrefix identifies every users row this suite inserts.
const pushTokenPhonePrefix = "+255946"

var pushTokenSeq atomic.Int64

// pushTokenPhone builds a per-run unique phone.
func pushTokenPhone() string {
	n := pushTokenSeq.Add(1)
	return fmt.Sprintf("%s%05d%04d", pushTokenPhonePrefix, time.Now().UnixNano()%100000, n%10000)
}

// pushTokenFixture wires the persistent server and owns cleanup of every row
// it creates: only its own push_tokens and users.
type pushTokenFixture struct {
	s       *Server
	pool    *pgxpool.Pool
	h       http.Handler
	userIDs []uuid.UUID
}

func newPushTokenFixture(t *testing.T) *pushTokenFixture {
	t.Helper()
	s, pool := newPersistentServer(t)
	f := &pushTokenFixture{s: s, pool: pool, h: s.Router()}
	t.Cleanup(func() { f.cleanup(context.Background()) })
	return f
}

// cleanup deletes only this suite's rows: own push_tokens rows (by user id;
// they cascade with the user anyway) and own users. Shared tables are
// untouched.
func (f *pushTokenFixture) cleanup(ctx context.Context) {
	if len(f.userIDs) > 0 {
		_, _ = f.pool.Exec(ctx, `DELETE FROM push_tokens WHERE user_id = ANY($1)`, f.userIDs)
		_, _ = f.pool.Exec(ctx, `DELETE FROM users WHERE id = ANY($1)`, f.userIDs)
	}
}

// user inserts a users row and returns its id and phone.
func (f *pushTokenFixture) user(t *testing.T) (uuid.UUID, string) {
	t.Helper()
	phone := pushTokenPhone()
	id := uuid.New()
	if _, err := f.pool.Exec(context.Background(),
		`INSERT INTO users (id, phone) VALUES ($1, $2)`, id, phone); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	f.userIDs = append(f.userIDs, id)
	return id, phone
}

// countTokens reports how many push_tokens rows exist for the given user
// (used to prove the upsert does not duplicate).
func (f *pushTokenFixture) countTokens(t *testing.T, userID uuid.UUID) int {
	t.Helper()
	var n int
	if err := f.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM push_tokens WHERE user_id = $1`, userID).Scan(&n); err != nil {
		t.Fatalf("count push tokens: %v", err)
	}
	return n
}

// TestPushTokenLifecycle: register → list → duplicate register (upsert, still
// one row) → delete → gone. DELETE of an unknown token stays 204.
func TestPushTokenLifecycle(t *testing.T) {
	f := newPushTokenFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)
	const deviceToken = "ExponentPushToken[lifecycle-device-001]"

	rec := authedDo(t, f.h, http.MethodPost, "/notifications/me/push-token",
		`{"token":"`+deviceToken+`","platform":"expo","deviceName":"Pixel 9"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register = %d (%s)", rec.Code, rec.Body)
	}
	var created pushTokenItem
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatalf("decode register response: %v", err)
	}
	if created.Token != deviceToken || created.Platform != "expo" {
		t.Fatalf("register response = %+v, want token %s platform expo", created, deviceToken)
	}
	if created.DeviceName == nil || *created.DeviceName != "Pixel 9" {
		t.Fatalf("register deviceName = %v, want Pixel 9", created.DeviceName)
	}
	if created.CreatedAt.IsZero() {
		t.Fatal("register response missing createdAt")
	}

	rec = authedGET(t, f.h, "/notifications/me/push-tokens", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list = %d (%s)", rec.Code, rec.Body)
	}
	var items []pushTokenItem
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(items) != 1 || items[0].Token != deviceToken {
		t.Fatalf("list = %+v, want exactly %s", items, deviceToken)
	}

	// Duplicate register upserts: same token, new device name, still one row.
	rec = authedDo(t, f.h, http.MethodPost, "/notifications/me/push-token",
		`{"token":"`+deviceToken+`","platform":"expo","deviceName":"Pixel 9 Pro"}`, token)
	if rec.Code != http.StatusCreated {
		t.Fatalf("duplicate register = %d (%s)", rec.Code, rec.Body)
	}
	var updated pushTokenItem
	if err := json.NewDecoder(rec.Body).Decode(&updated); err != nil {
		t.Fatalf("decode duplicate register: %v", err)
	}
	if updated.DeviceName == nil || *updated.DeviceName != "Pixel 9 Pro" {
		t.Fatalf("duplicate register deviceName = %v, want Pixel 9 Pro", updated.DeviceName)
	}
	if n := f.countTokens(t, f.userIDs[0]); n != 1 {
		t.Fatalf("push_tokens rows = %d, want 1 after duplicate register", n)
	}

	// Delete removes the row; a second delete stays 204 (idempotent).
	rec = authedDo(t, f.h, http.MethodDelete, "/notifications/me/push-token?token="+deviceToken, "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete = %d, want 204", rec.Code)
	}
	if n := f.countTokens(t, f.userIDs[0]); n != 0 {
		t.Fatalf("push_tokens rows = %d, want 0 after delete", n)
	}
	rec = authedDo(t, f.h, http.MethodDelete, "/notifications/me/push-token?token="+deviceToken, "", token)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("re-delete = %d, want 204 (idempotent)", rec.Code)
	}

	rec = authedGET(t, f.h, "/notifications/me/push-tokens", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("list after delete = %d (%s)", rec.Code, rec.Body)
	}
	items = nil
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode empty list: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("list after delete = %d items, want 0", len(items))
	}
}

// TestPushTokenInvalidPlatform: an unknown platform answers 422
// PUSH_TOKEN_INVALID and nothing is persisted.
func TestPushTokenInvalidPlatform(t *testing.T) {
	f := newPushTokenFixture(t)
	_, phone := f.user(t)
	token := tokenFor(t, f.s, phone, RoleCustomer, false)

	rec := authedDo(t, f.h, http.MethodPost, "/notifications/me/push-token",
		`{"token":"ExponentPushToken[bad-platform-device]","platform":"sms"}`, token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("register = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "PUSH_TOKEN_INVALID" {
		t.Fatalf("error code = %q, want PUSH_TOKEN_INVALID", errBody.Code)
	}
	if n := f.countTokens(t, f.userIDs[0]); n != 0 {
		t.Fatalf("push_tokens rows = %d, want 0 after rejected register", n)
	}
}

// TestPushTokenUserIsolation: tokens are scoped per user — a second user
// neither lists nor deletes the first user's tokens.
func TestPushTokenUserIsolation(t *testing.T) {
	f := newPushTokenFixture(t)
	_, phoneA := f.user(t)
	_, phoneB := f.user(t)
	tokenA := tokenFor(t, f.s, phoneA, RoleCustomer, false)
	tokenB := tokenFor(t, f.s, phoneB, RoleCustomer, false)
	const deviceToken = "ExponentPushToken[isolation-device-001]"

	rec := authedDo(t, f.h, http.MethodPost, "/notifications/me/push-token",
		`{"token":"`+deviceToken+`"}`, tokenA)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register A = %d (%s)", rec.Code, rec.Body)
	}

	// B's list is empty.
	rec = authedGET(t, f.h, "/notifications/me/push-tokens", tokenB)
	if rec.Code != http.StatusOK {
		t.Fatalf("list B = %d (%s)", rec.Code, rec.Body)
	}
	var items []pushTokenItem
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode list B: %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("B sees %d tokens, want 0", len(items))
	}

	// B deleting A's token is a no-op: A still has it.
	rec = authedDo(t, f.h, http.MethodDelete, "/notifications/me/push-token?token="+deviceToken, "", tokenB)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete by B = %d, want 204", rec.Code)
	}
	if n := f.countTokens(t, f.userIDs[0]); n != 1 {
		t.Fatalf("A push_tokens rows = %d, want 1 after B's delete", n)
	}

	// A still lists it.
	rec = authedGET(t, f.h, "/notifications/me/push-tokens", tokenA)
	if rec.Code != http.StatusOK {
		t.Fatalf("list A = %d (%s)", rec.Code, rec.Body)
	}
	items = nil
	if err := json.NewDecoder(rec.Body).Decode(&items); err != nil {
		t.Fatalf("decode list A: %v", err)
	}
	if len(items) != 1 || items[0].Token != deviceToken {
		t.Fatalf("A list = %+v, want exactly %s", items, deviceToken)
	}
}
