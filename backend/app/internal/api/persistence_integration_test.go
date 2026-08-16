//go:build integration

// End-to-end auth persistence tests against real PostgreSQL + Redis
// (docker compose). Run via `make test-integration` after `make migrate`.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/db"
)

func newPersistentServer(t *testing.T) (*Server, *pgxpool.Pool) {
	t.Helper()
	if os.Getenv("DATABASE_URL") == "" || os.Getenv("REDIS_URL") == "" {
		t.Skip("integration: DATABASE_URL and REDIS_URL required")
	}
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  24 * time.Hour,
		CORSOrigins: []string{"*"},
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),
	}
	s, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	d, err := db.New(context.Background(), cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	s.SetDB(d)
	t.Cleanup(d.Close)
	return s, d.Pool()
}

// uniqueDest builds a per-run unique destination so repeated integration runs
// never collide with rows left by earlier runs or by other packages.
func uniqueDest(prefix string) string {
	return fmt.Sprintf("%s%09d", prefix, time.Now().UnixNano()%1_000_000_000)
}

// TestAuthStateSurvivesRestart is the M3 exit criterion: after a full OTP
// flow, users/sessions/otp_requests rows exist; a fresh process (new server
// instance over the same Redis + PostgreSQL) still honors the session.
func TestAuthStateSurvivesRestart(t *testing.T) {
	dest := uniqueDest("+255755000111")
	s1, pool := newPersistentServer(t)
	h1 := s1.Router()

	rec := doJSON(t, h1, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"`+dest+`"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&delivery)
	if rec.Code != http.StatusOK {
		t.Fatalf("request-otp = %d (%s)", rec.Code, rec.Body)
	}

	rec = doJSON(t, h1, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	var session struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&session)
	if rec.Code != http.StatusOK || session.RefreshToken == "" {
		t.Fatalf("verify-otp = %d (%s)", rec.Code, rec.Body)
	}

	// Durable rows: user + customer role + session + verified otp request.
	var userID uuid.UUID
	err := pool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE phone = $1`, dest).Scan(&userID)
	if err != nil {
		t.Fatalf("user row missing: %v", err)
	}
	var roleCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM roles WHERE user_id = $1 AND role = 'customer' AND active`, userID).Scan(&roleCount); err != nil {
		t.Fatalf("role query: %v", err)
	}
	if roleCount != 1 {
		t.Fatalf("customer role missing for user %s", userID)
	}
	var sessionCount int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND refresh_token_hash != ''`,
		userID).Scan(&sessionCount); err != nil {
		t.Fatalf("session query: %v", err)
	}
	if sessionCount != 1 {
		t.Fatalf("session row count = %d, want 1", sessionCount)
	}
	var otpVerified int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM otp_requests WHERE destination = $1 AND verified_at IS NOT NULL AND code_hash != ''`,
		dest).Scan(&otpVerified); err != nil {
		t.Fatalf("otp query: %v", err)
	}
	if otpVerified != 1 {
		t.Fatalf("verified otp row count = %d, want 1", otpVerified)
	}

	// "Restart": a brand-new process over the same Redis + PostgreSQL. The
	// new process must NOT truncate; the first truncate at test start is all.
	s2, _ := newPersistentServer(t)
	h2 := s2.Router()
	rec = doJSON(t, h2, http.MethodPost, "/auth/refresh", `{"refreshToken":"`+session.RefreshToken+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh after restart = %d (%s)", rec.Code, rec.Body)
	}
	var rotated struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&rotated)
	if rotated.RefreshToken == "" || rotated.RefreshToken == session.RefreshToken {
		t.Fatal("refresh after restart did not rotate")
	}

	// The rotated session replaced the row (single live session per rotation
	// for THIS user — the table is shared with other integration suites).
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sessions WHERE user_id = $1 AND refresh_token_hash != '' AND revoked_at IS NULL`,
		userID).Scan(&sessionCount); err != nil {
		t.Fatalf("session recount: %v", err)
	}
	if sessionCount != 1 {
		t.Fatalf("live session rows = %d, want 1 after rotation", sessionCount)
	}
}

// TestFailedAttemptsMirroredToAudit verifies attempt counters land on the
// durable otp_requests row.
func TestFailedAttemptsMirroredToAudit(t *testing.T) {
	dest2 := uniqueDest("+255755000222")
	s, pool := newPersistentServer(t)
	h := s.Router()

	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"`+dest2+`"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&delivery)

	for i := 0; i < 3; i++ {
		rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
			`{"requestId":"`+delivery.RequestId+`","code":"654321"}`)
	}
	var attempts int
	if err := pool.QueryRow(context.Background(),
		`SELECT attempts FROM otp_requests WHERE destination = $1 ORDER BY created_at DESC LIMIT 1`,
		dest2).Scan(&attempts); err != nil {
		t.Fatalf("attempt query: %v", err)
	}
	if attempts != 3 {
		t.Fatalf("mirrored attempts = %d, want 3", attempts)
	}
}
