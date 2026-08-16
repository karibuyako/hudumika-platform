package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/hudumika/api-backend/internal/config"
)

// newReadyServer builds a server with a Redis-backed store set (miniredis),
// exercising the production store path in tests.
func newReadyServer(t *testing.T, redisURL string) *Server {
	t.Helper()
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  time.Hour,
		CORSOrigins: []string{"*"},
		RedisURL:    redisURL,
	}
	s, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	return s
}

func TestReadyzNothingConfiguredReturns503(t *testing.T) {
	s := newTestServer()
	rec := doJSON(t, s.Router(), http.MethodGet, "/readyz", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz status = %d, want 503", rec.Code)
	}
}

func TestReadyzRedisHealthyAndDown(t *testing.T) {
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	s := newReadyServer(t, "redis://"+mr.Addr())
	h := s.Router()

	rec := doJSON(t, h, http.MethodGet, "/readyz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz with healthy redis = %d, want 200", rec.Code)
	}

	// Bring Redis down: readyz must flip to 503.
	mr.Close()
	rec = doJSON(t, h, http.MethodGet, "/readyz", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz with down redis = %d, want 503", rec.Code)
	}
}

func TestRefreshTokenRotation(t *testing.T) {
	h := newTestServer().Router()

	// Full OTP flow to obtain a session.
	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"+255700111222"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = decodeInto(t, rec, &delivery)
	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	var session struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	_ = decodeInto(t, rec, &session)
	if session.RefreshToken == "" {
		t.Fatal("no refresh token issued")
	}

	// Refresh rotates the pair.
	rec = doJSON(t, h, http.MethodPost, "/auth/refresh",
		`{"refreshToken":"`+session.RefreshToken+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var rotated struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	_ = decodeInto(t, rec, &rotated)
	if rotated.RefreshToken == session.RefreshToken {
		t.Fatal("refresh token was not rotated")
	}

	// The old token is dead after rotation (reuse detection).
	rec = doJSON(t, h, http.MethodPost, "/auth/refresh",
		`{"refreshToken":"`+session.RefreshToken+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("reused refresh status = %d, want 401", rec.Code)
	}

	// The new token works.
	rec = doJSON(t, h, http.MethodPost, "/auth/refresh",
		`{"refreshToken":"`+rotated.RefreshToken+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("second refresh status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
}

func TestLogoutRevokesSession(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"+255700333444"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = decodeInto(t, rec, &delivery)
	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	var session struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = decodeInto(t, rec, &session)

	rec = doJSON(t, h, http.MethodPost, "/auth/logout", `{"refreshToken":"`+session.RefreshToken+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout status = %d, want 204", rec.Code)
	}

	rec = doJSON(t, h, http.MethodPost, "/auth/refresh", `{"refreshToken":"`+session.RefreshToken+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("refresh after logout = %d, want 401", rec.Code)
	}
}

func TestRefreshExpiredSessionRejected(t *testing.T) {
	s := newTestServer()
	s.cfg.RefreshTTL = time.Millisecond
	h := s.Router()

	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"+255700555666"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = decodeInto(t, rec, &delivery)
	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	var session struct {
		RefreshToken string `json:"refreshToken"`
	}
	_ = decodeInto(t, rec, &session)

	time.Sleep(5 * time.Millisecond)
	rec = doJSON(t, h, http.MethodPost, "/auth/refresh", `{"refreshToken":"`+session.RefreshToken+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expired refresh status = %d, want 401", rec.Code)
	}
}

func TestVerifyOtpRateLimitedPerIP(t *testing.T) {
	h := newTestServer().Router()
	for i := int64(0); i < verifyRateLimitIP; i++ {
		rec := doJSON(t, h, http.MethodPost, "/auth/verify-otp", `{"requestId":"nope","code":"000000"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("request %d status = %d, want 401", i, rec.Code)
		}
	}
	rec := doJSON(t, h, http.MethodPost, "/auth/verify-otp", `{"requestId":"nope","code":"000000"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header")
	}
}

// TestVerifyOtpRateLimitHeaders429 asserts the X-RateLimit-* trio on the 429
// response of the per-IP verify budget: the window budget, an exhausted
// remaining budget, and a reset instant in the future.
func TestVerifyOtpRateLimitHeaders429(t *testing.T) {
	h := newTestServer().Router()
	for i := int64(0); i < verifyRateLimitIP; i++ {
		rec := doJSON(t, h, http.MethodPost, "/auth/verify-otp", `{"requestId":"nope","code":"000000"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("request %d status = %d, want 401", i, rec.Code)
		}
	}
	rec := doJSON(t, h, http.MethodPost, "/auth/verify-otp", `{"requestId":"nope","code":"000000"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("X-RateLimit-Limit"); got != strconv.FormatInt(verifyRateLimitIP, 10) {
		t.Fatalf("X-RateLimit-Limit = %q, want %d", got, verifyRateLimitIP)
	}
	if got := rec.Header().Get("X-RateLimit-Remaining"); got != "0" {
		t.Fatalf("X-RateLimit-Remaining = %q, want 0", got)
	}
	reset, err := strconv.ParseInt(rec.Header().Get("X-RateLimit-Reset"), 10, 64)
	if err != nil {
		t.Fatalf("X-RateLimit-Reset not a unix second: %v", err)
	}
	if reset < time.Now().Unix() {
		t.Fatalf("X-RateLimit-Reset = %d, want >= now", reset)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header")
	}
}

// TestVerifyOtpRateLimitHeadersOnAllowedResponse asserts the trio rides a
// non-429 response too: the middleware stamps the headers before the handler
// runs, so the 422 from a garbage body (validation fails before any store
// access) still carries the budget and the remaining count.
func TestVerifyOtpRateLimitHeadersOnAllowedResponse(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/auth/verify-otp", `not json{`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	if got := rec.Header().Get("X-RateLimit-Limit"); got != strconv.FormatInt(verifyRateLimitIP, 10) {
		t.Fatalf("X-RateLimit-Limit = %q, want %d", got, verifyRateLimitIP)
	}
	if got := rec.Header().Get("X-RateLimit-Remaining"); got != strconv.FormatInt(verifyRateLimitIP-1, 10) {
		t.Fatalf("X-RateLimit-Remaining = %q, want %d", got, verifyRateLimitIP-1)
	}
	reset, err := strconv.ParseInt(rec.Header().Get("X-RateLimit-Reset"), 10, 64)
	if err != nil {
		t.Fatalf("X-RateLimit-Reset not a unix second: %v", err)
	}
	if reset < time.Now().Unix() {
		t.Fatalf("X-RateLimit-Reset = %d, want >= now", reset)
	}
}

func decodeInto(t *testing.T, rec *httptest.ResponseRecorder, dst any) error {
	t.Helper()
	return json.NewDecoder(rec.Body).Decode(dst)
}
