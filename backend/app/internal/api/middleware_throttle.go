package api

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// LoginThrottler enforces per-IP login attempt throttling.
// After maxAttempts failures within the window the IP is locked out.
type LoginThrottler struct {
	attempts map[string]*loginAttempt
	mu       sync.Mutex
}

type loginAttempt struct {
	count       int
	lockedUntil time.Time
}

const (
	throttleMaxAttempts = 10
	throttleWindow      = 15 * time.Minute
)

// NewLoginThrottler returns an initialised LoginThrottler.
func NewLoginThrottler() *LoginThrottler {
	return &LoginThrottler{
		attempts: make(map[string]*loginAttempt),
	}
}

// RecordFailed increments the failed attempt count for the given key.
// When the threshold is reached the key is locked for the window duration.
func (lt *LoginThrottler) RecordFailed(key string) {
	lt.mu.Lock()
	defer lt.mu.Unlock()

	now := time.Now()
	a, ok := lt.attempts[key]
	if !ok || now.After(a.lockedUntil) {
		lt.attempts[key] = &loginAttempt{count: 1, lockedUntil: now.Add(throttleWindow)}
		return
	}
	a.count++
	if a.count >= throttleMaxAttempts {
		a.lockedUntil = now.Add(throttleWindow)
	}
}

// IsLocked returns true if the key has exceeded the attempt budget.
func (lt *LoginThrottler) IsLocked(key string) bool {
	lt.mu.Lock()
	defer lt.mu.Unlock()

	a, ok := lt.attempts[key]
	if !ok {
		return false
	}
	if time.Now().After(a.lockedUntil) {
		delete(lt.attempts, key)
		return false
	}
	return a.count >= throttleMaxAttempts
}

// Reset clears attempts for the given key (called on successful login).
func (lt *LoginThrottler) Reset(key string) {
	lt.mu.Lock()
	defer lt.mu.Unlock()
	delete(lt.attempts, key)
}

// Middleware returns an HTTP middleware that blocks locked-out IPs from OTP
// endpoints. It extracts the client IP (X-Forwarded-For first, then RemoteAddr)
// and returns 429 LOGIN_THROTTLED with a Retry-After header when the budget is
// exceeded.
func (lt *LoginThrottler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := throttleClientIP(r)
		// Only throttle verify-otp (not request-otp) to avoid counting
		// the initial OTP request toward the attempt limit.
		if r.URL.Path == "/api/v1/auth/verify-otp" && lt.IsLocked(key) {
			lt.mu.Lock()
			a := lt.attempts[key]
			var retryAfter int
			if a != nil {
				retryAfter = int(time.Until(a.lockedUntil).Seconds())
				if retryAfter < 1 {
					retryAfter = 1
				}
			} else {
				retryAfter = int(throttleWindow.Seconds())
			}
			lt.mu.Unlock()

			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			writeErrorWithRetry(w, http.StatusTooManyRequests, "LOGIN_THROTTLED",
				"Too many failed login attempts — try again later", retryAfter)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// throttleClientIP extracts the client IP from the request.
func throttleClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range splitComma(xff) {
			if ip := trimSpace(part); ip != "" {
				return ip
			}
		}
	}
	return r.RemoteAddr
}

func splitComma(s string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	parts = append(parts, s[start:])
	return parts
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
