//go:build integration

package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestPool connects to the real database, or skips when DATABASE_URL is
// unset (the tests only run under `make test-integration`).
func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("pool ping: %v", err)
	}
	return pool
}

func truncateAll(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`TRUNCATE users, roles, sessions, otp_requests CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

func TestUpsertUserByPhoneIdempotent(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	phone := "+255700000001"
	id1, err := repo.UpsertUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	id2, err := repo.UpsertUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if id1 != id2 {
		t.Fatalf("expected same id on both upserts, got %s and %s", id1, id2)
	}

	u, err := repo.GetUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("get user: %v", err)
	}
	if u == nil {
		t.Fatal("expected user, got nil")
	}
	if u.Phone != phone {
		t.Fatalf("expected phone %q, got %q", phone, u.Phone)
	}
	if u.ID != id1 {
		t.Fatalf("expected id %s, got %s", id1, u.ID)
	}
}

func TestEnsureRoleNoDuplicates(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	userID, err := repo.UpsertUserByPhone(ctx, "+255700000002")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}

	for i := 0; i < 2; i++ {
		if err := repo.EnsureRole(ctx, userID, "customer"); err != nil {
			t.Fatalf("ensure role #%d: %v", i+1, err)
		}
	}

	var n int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM roles WHERE user_id = $1 AND role = 'customer'`, userID).Scan(&n); err != nil {
		t.Fatalf("count roles: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 role row, got %d", n)
	}
}

func TestSessionLifecycle(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	phone := "+255700000003"
	userID, err := repo.UpsertUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	if err := repo.EnsureRole(ctx, userID, "customer"); err != nil {
		t.Fatalf("ensure role: %v", err)
	}

	old := SessionRow{
		UserID:           userID,
		Role:             "customer",
		AccessTokenHash:  "access-hash-1",
		RefreshTokenHash: "refresh-hash-1",
		ExpiresAt:        time.Now().Add(time.Hour),
	}
	if _, err := repo.CreateSession(ctx, old); err != nil {
		t.Fatalf("create session: %v", err)
	}

	rotated := SessionRow{
		UserID:           userID,
		Role:             "customer",
		AccessTokenHash:  "access-hash-2",
		RefreshTokenHash: "refresh-hash-2",
		ExpiresAt:        time.Now().Add(2 * time.Hour),
	}
	if err := repo.RotateSession(ctx, old.RefreshTokenHash, rotated); err != nil {
		t.Fatalf("rotate session: %v", err)
	}

	// The rotation must not have touched the user row.
	u, err := repo.GetUserByPhone(ctx, phone)
	if err != nil {
		t.Fatalf("get user after rotate: %v", err)
	}
	if u == nil {
		t.Fatal("expected user after rotate, got nil")
	}
	if u.ID != userID {
		t.Fatalf("expected user id %s, got %s", userID, u.ID)
	}

	if err := repo.RevokeSession(ctx, rotated.RefreshTokenHash); err != nil {
		t.Fatalf("revoke session: %v", err)
	}

	// The row is now revoked, so rotating with the original hash finds nothing.
	again := SessionRow{
		UserID:           userID,
		Role:             "customer",
		AccessTokenHash:  "access-hash-3",
		RefreshTokenHash: "refresh-hash-3",
		ExpiresAt:        time.Now().Add(3 * time.Hour),
	}
	if err := repo.RotateSession(ctx, old.RefreshTokenHash, again); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("expected ErrSessionNotFound after revoke, got %v", err)
	}
}

func TestRotateSessionMissingHash(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	userID, err := repo.UpsertUserByPhone(ctx, "+255700000004")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	if _, err := repo.CreateSession(ctx, SessionRow{
		UserID:           userID,
		Role:             "customer",
		AccessTokenHash:  "access-hash-1",
		RefreshTokenHash: "refresh-hash-1",
		ExpiresAt:        time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	err = repo.RotateSession(ctx, "never-issued-hash", SessionRow{
		UserID:           userID,
		Role:             "customer",
		AccessTokenHash:  "access-hash-2",
		RefreshTokenHash: "refresh-hash-2",
		ExpiresAt:        time.Now().Add(time.Hour),
	})
	if !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("expected ErrSessionNotFound, got %v", err)
	}
}

func TestOtpRequestLifecycle(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	otpID, err := repo.CreateOtpRequest(ctx, OtpRequestRow{
		Channel:     "phone",
		Destination: "+255700000005",
		Purpose:     "login",
		CodeHash:    "otp-hash-1",
		ExpiresAt:   time.Now().Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatalf("create otp request: %v", err)
	}

	if err := repo.IncrementOtpAttempts(ctx, otpID); err != nil {
		t.Fatalf("increment attempts: %v", err)
	}

	var attempts int
	var verifiedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT attempts, verified_at FROM otp_requests WHERE id = $1`, otpID).
		Scan(&attempts, &verifiedAt); err != nil {
		t.Fatalf("select otp request: %v", err)
	}
	if attempts != 1 {
		t.Fatalf("expected 1 attempt after increment, got %d", attempts)
	}
	if verifiedAt != nil {
		t.Fatal("expected verified_at NULL before verification")
	}

	if err := repo.MarkOtpVerified(ctx, otpID); err != nil {
		t.Fatalf("mark verified: %v", err)
	}

	if err := pool.QueryRow(ctx,
		`SELECT attempts, verified_at FROM otp_requests WHERE id = $1`, otpID).
		Scan(&attempts, &verifiedAt); err != nil {
		t.Fatalf("re-select otp request: %v", err)
	}
	if attempts != 1 {
		t.Fatalf("expected attempts to stay 1, got %d", attempts)
	}
	if verifiedAt == nil {
		t.Fatal("expected verified_at set after verification")
	}
}

// TestMultiInstanceRotateSingleWinner pins the single-guarded-update
// semantics: 10 concurrent rotations with the same old hash and different new
// hashes must yield exactly one winner.
func TestMultiInstanceRotateSingleWinner(t *testing.T) {
	pool := newTestPool(t)
	truncateAll(t, pool)
	repo := NewRepo(pool)
	ctx := context.Background()

	userID, err := repo.UpsertUserByPhone(ctx, "+255700000006")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}

	const oldHash = "refresh-hash-shared"
	if _, err := repo.CreateSession(ctx, SessionRow{
		UserID:           userID,
		Role:             "customer",
		AccessTokenHash:  "access-hash-1",
		RefreshTokenHash: oldHash,
		ExpiresAt:        time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	const workers = 10
	results := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results <- repo.RotateSession(ctx, oldHash, SessionRow{
				UserID:           userID,
				Role:             "customer",
				AccessTokenHash:  fmt.Sprintf("access-hash-new-%d", i),
				RefreshTokenHash: fmt.Sprintf("refresh-hash-new-%d", i),
				ExpiresAt:        time.Now().Add(time.Hour),
			})
		}(i)
	}
	wg.Wait()
	close(results)

	wins, notFound := 0, 0
	for err := range results {
		switch {
		case err == nil:
			wins++
		case errors.Is(err, ErrSessionNotFound):
			notFound++
		default:
			t.Fatalf("unexpected error from rotation: %v", err)
		}
	}
	if wins != 1 || notFound != workers-1 {
		t.Fatalf("expected 1 winner and %d ErrSessionNotFound, got %d winners and %d not-found",
			workers-1, wins, notFound)
	}
}
