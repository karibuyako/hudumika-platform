package store

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// The store interfaces are the boundary between the API layer and the state
// backends. Redis is the production backend for every hot path; in-memory
// implementations exist for development and tests only. There is no other
// process-local state.

// ---- OTP ----

// OtpCreateInput carries everything needed to mint a new OTP.
type OtpCreateInput struct {
	Destination string
	Channel     string
	Purpose     string
	// DevCode when true mints the fixed development code (never in production).
	DevCode bool
	Now     time.Time
}

// OtpCreated is the result of a successful OTP mint. The plaintext Code is
// only ever in the caller's hand for delivery; it must never be logged or
// persisted.
type OtpCreated struct {
	RequestID string
	Code      string
	ExpiresAt time.Time
}

// OtpVerifyResult describes the outcome of a verify attempt.
type OtpVerifyResult struct {
	Verified bool
	// Destination is the verified destination (set only on success) — the
	// caller uses it as the session subject.
	Destination string
	// DBID is the durable otp_requests row id (when attached); used by the
	// service to keep the audit trail (attempts, verified_at) in sync.
	DBID string
	// AttemptsLeft is the remaining verify attempts before the OTP locks.
	// Negative when unknown (e.g. request not found).
	AttemptsLeft int
}

// Sentinels used by handlers to map to contract error codes.
var (
	ErrOtpUnknown = errors.New("otp: unknown or expired request")
	ErrOtpLocked  = errors.New("otp: max attempts reached")
)

// OtpStore mints, verifies, and rate-limits one-time passwords.
type OtpStore interface {
	// Create mints an OTP for the destination and returns the opaque request
	// id. Only the SHA-256 hash of the code is stored.
	Create(ctx context.Context, in OtpCreateInput) (OtpCreated, error)
	// Verify checks the code in constant time. The OTP is single-use: a
	// successful verify consumes it. Attempts are counted and lock the OTP at
	// the configured cap.
	Verify(ctx context.Context, requestID, code string, now time.Time) (OtpVerifyResult, error)
	// RateLimit enforces the per-destination request budget: 3 requests per 5
	// minutes with a 60 s minimum between resends (backend/AUTH.md).
	RateLimit(ctx context.Context, destination string, now time.Time) (RateLimitDecision, error)
	// AttachDBID records the durable audit-row id for the OTP request so the
	// service can mark attempts/verification on the persisted row. Best-effort
	// bookkeeping; failures are logged by the caller, not fatal.
	AttachDBID(ctx context.Context, requestID, dbID string) error
}

// ---- Sessions ----

// Session is a stored refresh session. Only the SHA-256 hash of the opaque
// refresh token is ever persisted. MfaVerified records whether the session's
// access token carried the mfa_verified claim at issue time.
type Session struct {
	Subject          string
	Role             string
	RefreshTokenHash string
	AccessTokenHash  string
	ExpiresAt        time.Time
	RevokedAt        time.Time
	MfaVerified      bool
}

// SessionStore persists opaque refresh-token sessions with rotation.
type SessionStore interface {
	// Create stores a new session keyed by refresh-token hash.
	Create(ctx context.Context, s Session) error
	// Get fetches a live (non-expired, non-revoked) session by hash.
	Get(ctx context.Context, refreshTokenHash string) (*Session, error)
	// Rotate atomically validates the old session and replaces it with the
	// next one (rotation on every refresh). It fails when the old session is
	// missing, expired, or revoked.
	Rotate(ctx context.Context, oldHash string, next Session) error
	// Revoke marks a session revoked server-side (logout).
	Revoke(ctx context.Context, refreshTokenHash string) error
	// CountActive returns the number of live sessions (for active_sessions).
	CountActive(ctx context.Context) (int64, error)
}

// ---- Rate limiting ----

// RateLimitDecision reports whether a request is allowed and, when not, how
// long the caller must wait. Consumed is the number of requests the current
// window has consumed, including the request being decided; it feeds the
// X-RateLimit-Remaining response header. Consumed == 0 means the backend
// does not report consumption — callers then treat the budget as fully
// consumed rather than over-advertising capacity.
type RateLimitDecision struct {
	Allowed    bool
	RetryAfter time.Duration
	Consumed   int64
}

// RateLimiter is a generic fixed-window limiter keyed by an arbitrary string
// (IP, destination, user). Redis-backed in production.
type RateLimiter interface {
	Allow(ctx context.Context, key string, limit int64, window time.Duration, now time.Time) (RateLimitDecision, error)
}

// ---- Idempotency ----

// IdempotentResponse is the stored response replayed for duplicate keys.
type IdempotentResponse struct {
	Status  int
	Headers http.Header
	Body    []byte
}

// ErrIdempotencyStoreDown signals the backend is unavailable; middleware must
// degrade (log and execute) instead of failing the request.
var ErrIdempotencyStoreDown = errors.New("idempotency: store unavailable")

// IdempotencyStore claims and replays idempotency keys (Redis SETNX + replay).
type IdempotencyStore interface {
	// Begin claims the key for a first execution. ok=false means a previous
	// request already owns it and its response can be replayed.
	Begin(ctx context.Context, key string, ttl time.Duration) (ok bool, err error)
	// Store records the response body for later replay.
	Store(ctx context.Context, key string, resp IdempotentResponse, ttl time.Duration) error
	// Get returns the stored response for a claimed-by-others key.
	Get(ctx context.Context, key string) (*IdempotentResponse, error)
}
