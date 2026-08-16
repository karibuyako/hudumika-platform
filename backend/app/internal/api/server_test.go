package api

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/config"
	"github.com/hudumika/api-backend/internal/gen"
)

func newTestServer() *Server {
	cfg := config.Config{
		Env:         "test",
		JWTSecret:   []byte("test-secret"),
		OTPDevCode:  "123456",
		AccessTTL:   time.Minute,
		RefreshTTL:  time.Hour,
		CORSOrigins: []string{"*"},
	}
	s, err := New(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		panic(err)
	}
	return s
}

func doJSON(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestOtpHappyPath(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"+255712345678"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("request-otp status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var delivery struct {
		RequestId        string `json:"requestId"`
		ExpiresInSeconds int    `json:"expiresInSeconds"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&delivery); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if delivery.RequestId == "" || delivery.ExpiresInSeconds != 300 {
		t.Fatalf("unexpected delivery: %+v", delivery)
	}

	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify-otp status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var session struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		User         struct {
			Id    string `json:"id"`
			Phone string `json:"phone"`
			Roles []struct {
				Role string `json:"role"`
			} `json:"roles"`
		} `json:"user"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&session); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if session.AccessToken == "" || session.RefreshToken == "" {
		t.Fatal("missing tokens")
	}
	if session.User.Phone != "+255712345678" {
		t.Fatalf("user phone = %q", session.User.Phone)
	}

	// Wrong code is rejected and consumes nothing else
	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"000000"}`)
	want := http.StatusUnauthorized
	// already consumed, expect 401
	if rec.Code != want {
		t.Fatalf("re-verify status = %d, want %d", rec.Code, want)
	}
}

func TestOtpWrongCodeRejected(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"+255700000001"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&delivery)

	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"654321"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "OTP_INVALID" {
		t.Fatalf("error code = %q", errBody.Code)
	}
}

func TestOtpWrongCodeConsumesAttemptsThenLocks(t *testing.T) {
	s := newTestServer()
	h := s.Router()
	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"+255700000002"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&delivery)

	for i := 0; i < 4; i++ {
		rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
			`{"requestId":"`+delivery.RequestId+`","code":"654321"}`)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d status = %d, want 401", i, rec.Code)
		}
	}
	// The 5th wrong attempt trips the lock and returns OTP_MAX_ATTEMPTS.
	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"654321"}`)
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "OTP_MAX_ATTEMPTS" {
		t.Fatalf("locked error code = %q, want OTP_MAX_ATTEMPTS", errBody.Code)
	}
	// The locked request is consumed (single-use gone): even the correct code
	// is rejected as an unknown request.
	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("after-lock status = %d, want 401", rec.Code)
	}
}

func TestOtpRateLimitedPerDestination(t *testing.T) {
	h := newTestServer().Router()
	dest := "+255711122233"

	// First request is allowed.
	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp",
		`{"channel":"phone","destination":"`+dest+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("first request status = %d, want 200", rec.Code)
	}

	// A resend within 60 seconds is rejected (AUTH.md resend rule).
	rec = doJSON(t, h, http.MethodPost, "/auth/request-otp",
		`{"channel":"phone","destination":"`+dest+`"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("resend status = %d, want 429", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "OTP_RATE_LIMITED" {
		t.Fatalf("error code = %q, want OTP_RATE_LIMITED", errBody.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("missing Retry-After header")
	}
	// Rate limiting is per destination: another destination is not affected.
	rec = doJSON(t, h, http.MethodPost, "/auth/request-otp",
		`{"channel":"phone","destination":"+255799988877"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("other destination status = %d, want 200", rec.Code)
	}
}

func TestProtectedRouteRequiresToken(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodGet, "/admin/templates", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q", errBody.Code)
	}
}

func TestNotImplementedIsJSON(t *testing.T) {
	s := newTestServer()
	// /admin/* is staff-only and requires MFA (AUTH.md); a customer session
	// would be rejected with 403 FORBIDDEN before the route is reached.
	// Mint a staff token with mfa_verified via the server's own mint path.
	token := tokenFor(t, s, "+255700000001", RoleAdmin, true)
	h := s.Router()

	// /events without Redis or PostgreSQL is the one remaining 501 state —
	// the envelope contract still holds there.
	req := httptest.NewRequest(http.MethodGet, "/events?after=0", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "NOT_IMPLEMENTED" {
		t.Fatalf("error code = %q", errBody.Code)
	}
}
