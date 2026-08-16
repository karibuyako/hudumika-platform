package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newRedisSessionsTest(t *testing.T) (*sessionRedisStores, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	c := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = c.Close() })
	return &sessionRedisStores{r: &Redis{client: c}}, mr
}

func testSession(hash, subject string, expiresAt time.Time) Session {
	return Session{
		Subject:          subject,
		Role:             "user",
		RefreshTokenHash: hash,
		AccessTokenHash:  "access-" + hash,
		ExpiresAt:        expiresAt,
	}
}

func TestRedisSessionCreateGet(t *testing.T) {
	rs, _ := newRedisSessionsTest(t)
	ctx := context.Background()

	want := testSession("aaa", "alice", time.Now().Truncate(time.Second).Add(time.Hour))
	if err := rs.Create(ctx, want); err != nil {
		t.Fatalf("Create: %v", err)
	}
	got, err := rs.Get(ctx, want.RefreshTokenHash)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got == nil {
		t.Fatal("Get returned nil for a live session")
	}
	if got.Subject != want.Subject || got.Role != want.Role ||
		got.RefreshTokenHash != want.RefreshTokenHash || got.AccessTokenHash != want.AccessTokenHash ||
		!got.ExpiresAt.Equal(want.ExpiresAt) || !got.RevokedAt.IsZero() {
		t.Fatalf("Get mismatch:\n got %+v\nwant %+v", got, want)
	}
}

func TestRedisSessionRotate(t *testing.T) {
	rs, _ := newRedisSessionsTest(t)
	ctx := context.Background()

	old := testSession("old", "alice", time.Now().Add(time.Hour))
	if err := rs.Create(ctx, old); err != nil {
		t.Fatalf("Create: %v", err)
	}
	next := testSession("new", "alice", time.Now().Add(time.Hour))
	if err := rs.Rotate(ctx, old.RefreshTokenHash, next); err != nil {
		t.Fatalf("Rotate: %v", err)
	}

	got, err := rs.Get(ctx, next.RefreshTokenHash)
	if err != nil {
		t.Fatalf("Get new: %v", err)
	}
	if got == nil || got.Subject != "alice" {
		t.Fatalf("Get new = %+v, want live session", got)
	}
	if got, err := rs.Get(ctx, old.RefreshTokenHash); err != nil {
		t.Fatalf("Get old: %v", err)
	} else if got != nil {
		t.Fatal("old session still live after rotate")
	}

	if err := rs.Rotate(ctx, old.RefreshTokenHash, testSession("reused", "alice", time.Now().Add(time.Hour))); err != ErrSessionInvalid {
		t.Fatalf("second Rotate with old hash = %v, want ErrSessionInvalid", err)
	}
}

func TestRedisSessionRotateRejectsExpired(t *testing.T) {
	rs, mr := newRedisSessionsTest(t)
	ctx := context.Background()

	old := testSession("old", "alice", time.Now().Add(time.Second))
	if err := rs.Create(ctx, old); err != nil {
		t.Fatalf("Create: %v", err)
	}
	mr.FastForward(2 * time.Second)

	err := rs.Rotate(ctx, old.RefreshTokenHash, testSession("new", "alice", time.Now().Add(time.Hour)))
	if err != ErrSessionInvalid {
		t.Fatalf("Rotate after expiry = %v, want ErrSessionInvalid", err)
	}
}

func TestRedisSessionRevoke(t *testing.T) {
	rs, _ := newRedisSessionsTest(t)
	ctx := context.Background()

	sess := testSession("rev", "alice", time.Now().Add(time.Hour))
	if err := rs.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := rs.Revoke(ctx, sess.RefreshTokenHash); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if got, err := rs.Get(ctx, sess.RefreshTokenHash); err != nil {
		t.Fatalf("Get after revoke: %v", err)
	} else if got != nil {
		t.Fatal("revoked session still returned by Get")
	}

	err := rs.Rotate(ctx, sess.RefreshTokenHash, testSession("new", "alice", time.Now().Add(time.Hour)))
	if err != ErrSessionInvalid {
		t.Fatalf("Rotate after revoke = %v, want ErrSessionInvalid", err)
	}
}

func TestRedisSessionExpiryCleansKey(t *testing.T) {
	rs, mr := newRedisSessionsTest(t)
	ctx := context.Background()

	sess := testSession("tmp", "alice", time.Now().Add(time.Second))
	if err := rs.Create(ctx, sess); err != nil {
		t.Fatalf("Create: %v", err)
	}
	mr.FastForward(2 * time.Second)

	if got, err := rs.Get(ctx, sess.RefreshTokenHash); err != nil {
		t.Fatalf("Get after expiry: %v", err)
	} else if got != nil {
		t.Fatal("expired session still returned by Get")
	}
	if mr.Exists(sessionKey(sess.RefreshTokenHash)) {
		t.Fatal("expired session key still present")
	}
}

func TestRedisSessionCountActive(t *testing.T) {
	rs, mr := newRedisSessionsTest(t)
	ctx := context.Background()

	long := time.Now().Add(time.Hour)
	for i := 0; i < 3; i++ {
		if err := rs.Create(ctx, testSession(fmt.Sprintf("h%d", i), "alice", long)); err != nil {
			t.Fatalf("Create: %v", err)
		}
	}
	mr.FastForward(10 * time.Second)

	// Two more sessions: one long-lived, one short-lived.
	if err := rs.Create(ctx, testSession("h3", "alice", time.Now().Add(time.Hour))); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := rs.Create(ctx, testSession("h4", "alice", time.Now().Add(5*time.Minute))); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := rs.Revoke(ctx, "h0"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}

	if n, err := rs.CountActive(ctx); err != nil {
		t.Fatalf("CountActive: %v", err)
	} else if n != 4 {
		t.Fatalf("CountActive = %d, want 4", n)
	}

	// h4 (5 min TTL) expires; the others remain live.
	mr.FastForward(6 * time.Minute)
	if n, err := rs.CountActive(ctx); err != nil {
		t.Fatalf("CountActive: %v", err)
	} else if n != 3 {
		t.Fatalf("CountActive after expiry = %d, want 3", n)
	}
}

func TestRedisSessionRotationAtomic(t *testing.T) {
	rs, mr := newRedisSessionsTest(t)
	ctx := context.Background()

	old := testSession("old", "alice", time.Now().Add(time.Hour))
	if err := rs.Create(ctx, old); err != nil {
		t.Fatalf("Create: %v", err)
	}
	next := testSession("new", "alice", time.Now().Add(time.Hour))
	if err := rs.Rotate(ctx, old.RefreshTokenHash, next); err != nil {
		t.Fatalf("Rotate: %v", err)
	}

	if mr.Exists(sessionKey(old.RefreshTokenHash)) {
		t.Fatal("old session key still exists after rotate")
	}
	if !mr.Exists(sessionKey(next.RefreshTokenHash)) {
		t.Fatal("next session key missing after rotate")
	}
}
