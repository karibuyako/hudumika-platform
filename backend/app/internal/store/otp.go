package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"math/big"
	"sync"
	"time"

	"github.com/google/uuid"
)

// In-memory OTP store for development and tests only. The production path is
// Redis (otp_redis.go); a NewSet that silently downgrades to this store in
// production is a bug — config validation refuses production without Redis.

const (
	otpTTL            = 5 * time.Minute
	otpMaxAttempts    = 5
	otpMaxRequests    = 3
	otpRateWindow     = 5 * time.Minute
	otpMinResendDelay = 60 * time.Second
	otpDigits         = 6
	devCode           = "123456"
)

// Exported aliases for the API layer's X-RateLimit-* response headers on
// /auth/request-otp: a budget of OtpRequestBudget per OtpRateWindow.
const (
	OtpRequestBudget int64 = otpMaxRequests
	OtpRateWindow          = otpRateWindow
)

type memoryOtpStore struct {
	mu       sync.Mutex
	requests map[string]otpRecord
	// destination -> request timestamps within the rate window
	rate map[string][]time.Time
}

type otpRecord struct {
	codeHash    [32]byte
	destination string
	channel     string
	purpose     string
	expiresAt   time.Time
	attempts    int
	verified    bool
	dbID        string
}

func NewMemoryOtpStore() OtpStore {
	return &memoryOtpStore{
		requests: make(map[string]otpRecord),
		rate:     make(map[string][]time.Time),
	}
}

func (s *memoryOtpStore) Create(ctx context.Context, in OtpCreateInput) (OtpCreated, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	code := randomCode()
	if in.DevCode {
		code = devCode
	}
	reqID := newRequestID()
	s.requests[reqID] = otpRecord{
		codeHash:    sha256.Sum256([]byte(code)),
		destination: in.Destination,
		channel:     in.Channel,
		purpose:     in.Purpose,
		expiresAt:   in.Now.Add(otpTTL),
	}
	return OtpCreated{
		RequestID: reqID,
		Code:      code,
		ExpiresAt: in.Now.Add(otpTTL),
	}, nil
}

func (s *memoryOtpStore) Verify(ctx context.Context, requestID, code string, now time.Time) (OtpVerifyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.requests[requestID]
	if !ok || now.After(rec.expiresAt) {
		delete(s.requests, requestID)
		return OtpVerifyResult{}, ErrOtpUnknown
	}
	if rec.verified {
		delete(s.requests, requestID)
		return OtpVerifyResult{}, ErrOtpUnknown
	}
	if rec.attempts >= otpMaxAttempts {
		delete(s.requests, requestID)
		return OtpVerifyResult{}, ErrOtpLocked
	}

	want := sha256.Sum256([]byte(code))
	// Constant-time comparison of the digests.
	if subtle.ConstantTimeCompare(want[:], rec.codeHash[:]) != 1 {
		rec.attempts++
		left := otpMaxAttempts - rec.attempts
		if left <= 0 {
			delete(s.requests, requestID)
			return OtpVerifyResult{AttemptsLeft: 0, DBID: rec.dbID}, ErrOtpLocked
		}
		s.requests[requestID] = rec
		return OtpVerifyResult{AttemptsLeft: left, DBID: rec.dbID}, nil
	}

	rec.verified = true
	dest := rec.destination
	dbID := rec.dbID
	delete(s.requests, requestID)
	return OtpVerifyResult{Verified: true, Destination: dest, DBID: dbID}, nil
}

func (s *memoryOtpStore) AttachDBID(ctx context.Context, requestID, dbID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.requests[requestID]; ok {
		rec.dbID = dbID
		s.requests[requestID] = rec
	}
	return nil
}

func (s *memoryOtpStore) RateLimit(ctx context.Context, destination string, now time.Time) (RateLimitDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	stamps := s.rate[destination]
	windowStart := now.Add(-otpRateWindow)
	kept := stamps[:0]
	for _, t := range stamps {
		if t.After(windowStart) {
			kept = append(kept, t)
		}
	}
	stamps = kept

	if len(stamps) > 0 {
		if d := now.Sub(stamps[len(stamps)-1]); d < otpMinResendDelay {
			s.rate[destination] = stamps
			return RateLimitDecision{RetryAfter: otpMinResendDelay - d, Consumed: int64(len(stamps))}, nil
		}
	}
	if len(stamps) >= otpMaxRequests {
		oldest := stamps[0]
		s.rate[destination] = stamps
		return RateLimitDecision{RetryAfter: oldest.Add(otpRateWindow).Sub(now), Consumed: int64(len(stamps)) + 1}, nil
	}
	s.rate[destination] = append(stamps, now)
	return RateLimitDecision{Allowed: true, Consumed: int64(len(stamps)) + 1}, nil
}

func randomCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "000000"
	}
	return pad6(n.Int64())
}

func pad6(n int64) string {
	b := []byte{'0', '0', '0', '0', '0', '0'}
	for i := 5; i >= 0; i-- {
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b)
}

func newRequestID() string {
	u, err := uuid.NewRandom()
	if err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	return u.String()
}
