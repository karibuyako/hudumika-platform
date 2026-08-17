package store

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const sessionKeyPrefix = "sess:"

func sessionKey(hash string) string { return sessionKeyPrefix + hash }

// sessionTTL clamps the remaining lifetime to at least 1s.
func sessionTTL(s Session, now time.Time) time.Duration {
	ttl := s.ExpiresAt.Sub(now)
	if ttl < time.Second {
		ttl = time.Second
	}
	return ttl
}

func sessionFields(s Session) map[string]interface{} {
	fields := map[string]interface{}{
		"subject":           s.Subject,
		"role":              s.Role,
		"access_token_hash": s.AccessTokenHash,
		"expires_at":        s.ExpiresAt.Unix(),
	}
	if s.MfaVerified {
		fields["mfa_verified"] = "1"
	}
	if !s.RevokedAt.IsZero() {
		fields["revoked_at"] = s.RevokedAt.Unix()
	}
	return fields
}

// rotateSessionScript atomically validates the old session and replaces it
// with the next one. Returns 1 on success, 0 when the old session is missing,
// expired, or revoked. KEYS[1] = old key, KEYS[2] = next key; ARGV[1] = now
// (unix), ARGV[2] = next TTL (s), ARGV[3..6] = next session fields.
// NOTE: the mfa_verified flag is NOT carried across rotation — the caller
// (token refresh) mints the next access token without the claim, so the
// record must not advertise one.
var rotateSessionScript = redis.NewScript(`
local expires = redis.call('HGET', KEYS[1], 'expires_at')
if not expires then
	return 0
end
if tonumber(expires) <= tonumber(ARGV[1]) then
	return 0
end
local revoked = redis.call('HGET', KEYS[1], 'revoked_at')
if revoked and tonumber(revoked) > 0 then
	return 0
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[2], 'subject', ARGV[3], 'role', ARGV[4],
	'access_token_hash', ARGV[5], 'expires_at', ARGV[6])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`)

func (rs *sessionRedisStores) Create(ctx context.Context, s Session) error {
	key := sessionKey(s.RefreshTokenHash)
	pipe := rs.r.client.TxPipeline()
	pipe.HSet(ctx, key, sessionFields(s))
	pipe.Expire(ctx, key, sessionTTL(s, time.Now()))
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store: create session: %w", err)
	}
	return nil
}

func (rs *sessionRedisStores) Get(ctx context.Context, refreshTokenHash string) (*Session, error) {
	key := sessionKey(refreshTokenHash)
	fields, err := rs.r.client.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("store: get session: %w", err)
	}
	if len(fields) == 0 {
		return nil, nil
	}

	expiresAt, err := strconv.ParseInt(fields["expires_at"], 10, 64)
	if err != nil || expiresAt <= time.Now().Unix() {
		_ = rs.r.client.Del(ctx, key).Err()
		return nil, nil
	}
	revokedAt, err := strconv.ParseInt(fields["revoked_at"], 10, 64)
	if err == nil && revokedAt > 0 {
		return nil, nil
	}

	sess := &Session{
		Subject:          fields["subject"],
		Role:             fields["role"],
		RefreshTokenHash: refreshTokenHash,
		AccessTokenHash:  fields["access_token_hash"],
		ExpiresAt:        time.Unix(expiresAt, 0),
		MfaVerified:      fields["mfa_verified"] == "1",
	}
	if err == nil && revokedAt > 0 {
		sess.RevokedAt = time.Unix(revokedAt, 0)
	}
	return sess, nil
}

func (rs *sessionRedisStores) Rotate(ctx context.Context, oldHash string, next Session) error {
	now := time.Now()
	res, err := rotateSessionScript.Run(ctx, rs.r.client,
		[]string{sessionKey(oldHash), sessionKey(next.RefreshTokenHash)},
		now.Unix(), int64(sessionTTL(next, now)/time.Second),
		next.Subject, next.Role, next.AccessTokenHash, next.ExpiresAt.Unix(),
	).Int64()
	if err != nil {
		return fmt.Errorf("store: rotate session: %w", err)
	}
	if res != 1 {
		return ErrSessionInvalid
	}
	return nil
}

func (rs *sessionRedisStores) Revoke(ctx context.Context, refreshTokenHash string) error {
	if err := rs.r.client.HSet(ctx, sessionKey(refreshTokenHash), "revoked_at", time.Now().Unix()).Err(); err != nil {
		return fmt.Errorf("store: revoke session: %w", err)
	}
	return nil
}

func (rs *sessionRedisStores) CountActive(ctx context.Context) (int64, error) {
	var count int64
	now := time.Now().Unix()
	iter := rs.r.client.Scan(ctx, 0, sessionKeyPrefix+"*", 500).Iterator()
	for iter.Next(ctx) {
		fields, err := rs.r.client.HGetAll(ctx, iter.Val()).Result()
		if err != nil {
			return 0, fmt.Errorf("store: count active sessions: %w", err)
		}
		expiresAt, err := strconv.ParseInt(fields["expires_at"], 10, 64)
		if err != nil || expiresAt <= now {
			continue
		}
		if revokedAt, err := strconv.ParseInt(fields["revoked_at"], 10, 64); err == nil && revokedAt > 0 {
			continue
		}
		count++
	}
	if err := iter.Err(); err != nil {
		return 0, fmt.Errorf("store: count active sessions: %w", err)
	}
	return count, nil
}
