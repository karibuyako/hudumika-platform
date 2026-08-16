package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

func otpKey(requestID string) string {
	return "otp:" + requestID
}

func (rs *otpRedisStores) Create(ctx context.Context, in OtpCreateInput) (OtpCreated, error) {
	code := randomCode()
	if in.DevCode {
		code = devCode
	}
	reqID := newRequestID()
	sum := sha256.Sum256([]byte(code))
	key := otpKey(reqID)

	pipe := rs.r.client.Pipeline()
	pipe.HSet(ctx, key, map[string]interface{}{
		"code_hash":   hex.EncodeToString(sum[:]),
		"destination": in.Destination,
		"channel":     in.Channel,
		"purpose":     in.Purpose,
		"attempts":    "0",
		"created_at":  in.Now.Unix(),
	})
	pipe.Expire(ctx, key, otpTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return OtpCreated{}, fmt.Errorf("otp create: %w", err)
	}
	return OtpCreated{RequestID: reqID, Code: code, ExpiresAt: in.Now.Add(otpTTL)}, nil
}

// AttachDBID records the durable otp_requests row id on the hot-path record
// so attempts/verified can be mirrored to the audit trail.
func (rs *otpRedisStores) AttachDBID(ctx context.Context, requestID, dbID string) error {
	if err := rs.r.client.HSet(ctx, otpKey(requestID), "otp_db_id", dbID).Err(); err != nil {
		return fmt.Errorf("otp attach db id: %w", err)
	}
	return nil
}

func (rs *otpRedisStores) Verify(ctx context.Context, requestID, code string, now time.Time) (OtpVerifyResult, error) {
	key := otpKey(requestID)
	stored, err := rs.r.client.HGet(ctx, key, "code_hash").Result()
	if errors.Is(err, redis.Nil) {
		return OtpVerifyResult{}, ErrOtpUnknown
	}
	if err != nil {
		return OtpVerifyResult{}, fmt.Errorf("otp verify: %w", err)
	}

	want := sha256.Sum256([]byte(code))
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(want[:])), []byte(stored)) == 1 {
		fields, err := rs.r.client.HGetAll(ctx, key).Result()
		if err != nil {
			return OtpVerifyResult{}, fmt.Errorf("otp verify consume: %w", err)
		}
		if err := rs.r.client.Del(ctx, key).Err(); err != nil {
			return OtpVerifyResult{}, fmt.Errorf("otp verify consume: %w", err)
		}
		return OtpVerifyResult{Verified: true, Destination: fields["destination"], DBID: fields["otp_db_id"]}, nil
	}

	attempts, err := rs.r.client.HIncrBy(ctx, key, "attempts", 1).Result()
	if err != nil {
		return OtpVerifyResult{}, fmt.Errorf("otp verify attempts: %w", err)
	}
	dbID, _ := rs.r.client.HGet(ctx, key, "otp_db_id").Result()
	if attempts >= otpMaxAttempts {
		if err := rs.r.client.Del(ctx, key).Err(); err != nil {
			return OtpVerifyResult{}, fmt.Errorf("otp verify lock: %w", err)
		}
		return OtpVerifyResult{AttemptsLeft: 0, DBID: dbID}, ErrOtpLocked
	}
	return OtpVerifyResult{AttemptsLeft: otpMaxAttempts - int(attempts), DBID: dbID}, nil
}

func (rs *otpRedisStores) RateLimit(ctx context.Context, destination string, now time.Time) (RateLimitDecision, error) {
	lastKey := "otp:last:" + destination
	rlKey := "otp:rl:" + destination
	last, err := rs.r.client.Get(ctx, lastKey).Int64()
	switch {
	case err == nil:
		if d := now.Sub(time.Unix(last, 0)); d < otpMinResendDelay {
			// Denied by the 60 s resend delay. Report the window count
			// best-effort; a failed read leaves Consumed 0, which callers
			// treat as the budget being fully consumed.
			consumed, _ := rs.r.client.Get(ctx, rlKey).Int64()
			return RateLimitDecision{RetryAfter: otpMinResendDelay - d, Consumed: consumed}, nil
		}
	case !errors.Is(err, redis.Nil):
		return RateLimitDecision{}, fmt.Errorf("otp rate limit: %w", err)
	}

	pipe := rs.r.client.TxPipeline()
	incr := pipe.Incr(ctx, rlKey)
	pipe.Set(ctx, lastKey, now.Unix(), otpRateWindow)
	if _, err := pipe.Exec(ctx); err != nil {
		return RateLimitDecision{}, fmt.Errorf("otp rate limit: %w", err)
	}
	if incr.Val() == 1 {
		if err := rs.r.client.Expire(ctx, rlKey, otpRateWindow).Err(); err != nil {
			return RateLimitDecision{}, fmt.Errorf("otp rate limit: %w", err)
		}
	}
	if incr.Val() > otpMaxRequests {
		ttl, err := rs.r.client.TTL(ctx, rlKey).Result()
		if err != nil {
			return RateLimitDecision{}, fmt.Errorf("otp rate limit ttl: %w", err)
		}
		if ttl < 0 {
			ttl = otpRateWindow
		}
		return RateLimitDecision{RetryAfter: ttl, Consumed: incr.Val()}, nil
	}
	return RateLimitDecision{Allowed: true, Consumed: incr.Val()}, nil
}

func (rs *otpRedisStores) Allow(ctx context.Context, key string, limit int64, window time.Duration, now time.Time) (RateLimitDecision, error) {
	rk := "rl:" + key
	pipe := rs.r.client.TxPipeline()
	incr := pipe.Incr(ctx, rk)
	if _, err := pipe.Exec(ctx); err != nil {
		return RateLimitDecision{}, fmt.Errorf("rate limit: %w", err)
	}
	if incr.Val() == 1 {
		if err := rs.r.client.Expire(ctx, rk, window).Err(); err != nil {
			return RateLimitDecision{}, fmt.Errorf("rate limit: %w", err)
		}
	}
	if incr.Val() > limit {
		ttl, err := rs.r.client.TTL(ctx, rk).Result()
		if err != nil {
			return RateLimitDecision{}, fmt.Errorf("rate limit ttl: %w", err)
		}
		if ttl < 0 {
			ttl = window
		}
		return RateLimitDecision{RetryAfter: ttl, Consumed: incr.Val()}, nil
	}
	return RateLimitDecision{Allowed: true, Consumed: incr.Val()}, nil
}
