package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newRedisOtpTest(t *testing.T) (*miniredis.Miniredis, *otpRedisStores) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	c := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = c.Close() })
	return mr, &otpRedisStores{r: &Redis{client: c}}
}

func mustCreateOtp(t *testing.T, r *otpRedisStores, dest, purpose string, at time.Time) OtpCreated {
	t.Helper()
	created, err := r.Create(context.Background(), OtpCreateInput{
		Destination: dest,
		Channel:     "phone",
		Purpose:     purpose,
		Now:         at,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return created
}

func TestRedisOtpCreateStoresOnlyHash(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()

	created, err := r.Create(ctx, OtpCreateInput{
		Destination: "+255712345678",
		Channel:     "phone",
		Purpose:     "login",
		Now:         time.Now(),
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !mr.Exists("otp:" + created.RequestID) {
		t.Fatalf("otp:%s missing", created.RequestID)
	}
	got := mr.HGet("otp:"+created.RequestID, "code_hash")
	sum := sha256.Sum256([]byte(created.Code))
	if want := hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("code_hash = %q, want %q", got, want)
	}
	keys, err := mr.HKeys("otp:" + created.RequestID)
	if err != nil {
		t.Fatalf("HKeys: %v", err)
	}
	if len(keys) != 6 {
		t.Fatalf("hash has %d fields, want 6: %v", len(keys), keys)
	}
	for _, k := range keys {
		if mr.HGet("otp:"+created.RequestID, k) == created.Code {
			t.Fatalf("plaintext code stored under field %q", k)
		}
	}
	all := mr.Keys()
	if len(all) != 1 || all[0] != "otp:"+created.RequestID {
		t.Fatalf("unexpected keys in db: %v", all)
	}
}

func TestRedisOtpVerifyCorrectCode(t *testing.T) {
	_, r := newRedisOtpTest(t)
	ctx := context.Background()
	created := mustCreateOtp(t, r, "+255712345678", "login", time.Now())

	res, err := r.Verify(ctx, created.RequestID, created.Code, time.Now())
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !res.Verified {
		t.Fatalf("Verify result = %+v, want Verified", res)
	}
	if _, err := r.Verify(ctx, created.RequestID, created.Code, time.Now()); !errors.Is(err, ErrOtpUnknown) {
		t.Fatalf("second Verify err = %v, want ErrOtpUnknown", err)
	}
}

func TestRedisOtpVerifyWrongCodeCountsAttempts(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()
	created := mustCreateOtp(t, r, "+255712345678", "login", time.Now())

	wrong := "000000"
	if wrong == created.Code {
		wrong = "000001"
	}
	for i := 1; i < otpMaxAttempts; i++ {
		res, err := r.Verify(ctx, created.RequestID, wrong, time.Now())
		if err != nil {
			t.Fatalf("Verify %d: %v", i, err)
		}
		if res.Verified {
			t.Fatalf("Verify %d: unexpected verified", i)
		}
		if want := otpMaxAttempts - i; res.AttemptsLeft != want {
			t.Fatalf("Verify %d AttemptsLeft = %d, want %d", i, res.AttemptsLeft, want)
		}
	}
	res, err := r.Verify(ctx, created.RequestID, wrong, time.Now())
	if !errors.Is(err, ErrOtpLocked) {
		t.Fatalf("final Verify err = %v, want ErrOtpLocked", err)
	}
	if res.AttemptsLeft != 0 {
		t.Fatalf("final AttemptsLeft = %d, want 0", res.AttemptsLeft)
	}
	if _, err := r.Verify(ctx, created.RequestID, created.Code, time.Now()); !errors.Is(err, ErrOtpUnknown) {
		t.Fatalf("Verify after lock err = %v, want ErrOtpUnknown", err)
	}
	if mr.Exists("otp:" + created.RequestID) {
		t.Fatal("otp key still present after lock")
	}
}

func TestRedisOtpVerifyExpired(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()
	created := mustCreateOtp(t, r, "+255712345678", "login", time.Now())

	mr.FastForward(301 * time.Second)
	if _, err := r.Verify(ctx, created.RequestID, created.Code, time.Now().Add(301*time.Second)); !errors.Is(err, ErrOtpUnknown) {
		t.Fatalf("Verify after expiry err = %v, want ErrOtpUnknown", err)
	}
}

func TestRedisOtpRateLimitThreePerFiveMin(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()
	dest := "+255711122233"
	t0 := time.Now()

	purposes := []string{"login", "signup", "password_reset"}
	for i := 0; i < otpMaxRequests; i++ {
		at := t0.Add(time.Duration(i) * (otpMinResendDelay + time.Second))
		d, err := r.RateLimit(ctx, dest, at)
		if err != nil {
			t.Fatalf("RateLimit %d: %v", i, err)
		}
		if !d.Allowed {
			t.Fatalf("RateLimit %d not allowed: %+v", i, d)
		}
		mustCreateOtp(t, r, dest, purposes[i], at)
	}

	d, err := r.RateLimit(ctx, dest, t0.Add(otpMinResendDelay*3+3*time.Second))
	if err != nil {
		t.Fatalf("RateLimit 4th: %v", err)
	}
	if d.Allowed {
		t.Fatal("4th RateLimit allowed, want denied")
	}
	if d.RetryAfter <= 0 {
		t.Fatalf("4th RetryAfter = %v, want > 0", d.RetryAfter)
	}

	mr.FastForward(301 * time.Second)
	d, err = r.RateLimit(ctx, dest, t0.Add(301*time.Second))
	if err != nil {
		t.Fatalf("RateLimit after window: %v", err)
	}
	if !d.Allowed {
		t.Fatalf("RateLimit after window not allowed: %+v", d)
	}
}

func TestRedisOtpResendDelay60s(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()
	dest := "+255700000002"
	t0 := time.Now()

	d, err := r.RateLimit(ctx, dest, t0)
	if err != nil || !d.Allowed {
		t.Fatalf("first RateLimit: %+v %v", d, err)
	}
	mustCreateOtp(t, r, dest, "login", t0)

	d, err = r.RateLimit(ctx, dest, t0.Add(30*time.Second))
	if err != nil {
		t.Fatalf("second RateLimit: %v", err)
	}
	if d.Allowed {
		t.Fatal("second RateLimit allowed, want denied")
	}
	if d.RetryAfter <= 29*time.Second || d.RetryAfter > 30*time.Second {
		t.Fatalf("RetryAfter = %v, want ~30s", d.RetryAfter)
	}

	mr.FastForward(31 * time.Second)
	d, err = r.RateLimit(ctx, dest, t0.Add(61*time.Second))
	if err != nil {
		t.Fatalf("third RateLimit: %v", err)
	}
	if !d.Allowed {
		t.Fatalf("third RateLimit not allowed: %+v", d)
	}
}

func TestRedisRateLimiterAllow(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()
	key := "ip:10.0.0.1"
	now := time.Now()

	for i := 0; i < 3; i++ {
		d, err := r.Allow(ctx, key, 3, time.Minute, now)
		if err != nil {
			t.Fatalf("Allow %d: %v", i, err)
		}
		if !d.Allowed {
			t.Fatalf("Allow %d not allowed: %+v", i, d)
		}
	}
	d, err := r.Allow(ctx, key, 3, time.Minute, now.Add(time.Second))
	if err != nil {
		t.Fatalf("Allow 4th: %v", err)
	}
	if d.Allowed || d.RetryAfter <= 0 {
		t.Fatalf("Allow 4th = %+v, want denied", d)
	}

	mr.FastForward(61 * time.Second)
	d, err = r.Allow(ctx, key, 3, time.Minute, now.Add(61*time.Second))
	if err != nil {
		t.Fatalf("Allow after window: %v", err)
	}
	if !d.Allowed {
		t.Fatalf("Allow after window not allowed: %+v", d)
	}
}

func TestRedisRateLimiterAllowReportsConsumed(t *testing.T) {
	mr, r := newRedisOtpTest(t)
	ctx := context.Background()
	key := "ip:10.0.0.9"
	now := time.Now()

	for i := int64(1); i <= 3; i++ {
		d, err := r.Allow(ctx, key, 3, time.Minute, now)
		if err != nil {
			t.Fatalf("Allow %d: %v", i, err)
		}
		if !d.Allowed {
			t.Fatalf("Allow %d not allowed: %+v", i, d)
		}
		if d.Consumed != i {
			t.Fatalf("Allow %d Consumed = %d, want %d", i, d.Consumed, i)
		}
	}
	d, err := r.Allow(ctx, key, 3, time.Minute, now.Add(time.Second))
	if err != nil {
		t.Fatalf("Allow 4th: %v", err)
	}
	if d.Allowed {
		t.Fatal("Allow 4th allowed, want denied")
	}
	if d.Consumed != 4 {
		t.Fatalf("Allow 4th Consumed = %d, want 4", d.Consumed)
	}
	if d.RetryAfter <= 0 {
		t.Fatalf("Allow 4th RetryAfter = %v, want > 0", d.RetryAfter)
	}

	mr.FastForward(61 * time.Second)
	d, err = r.Allow(ctx, key, 3, time.Minute, now.Add(61*time.Second))
	if err != nil {
		t.Fatalf("Allow after window: %v", err)
	}
	if !d.Allowed {
		t.Fatalf("Allow after window not allowed: %+v", d)
	}
	if d.Consumed != 1 {
		t.Fatalf("Allow after window Consumed = %d, want 1", d.Consumed)
	}
}
