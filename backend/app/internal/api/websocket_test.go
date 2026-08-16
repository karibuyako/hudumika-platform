package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// wsRequest runs a plain HTTP GET against /ws (no upgrade headers): the
// handler must reject before any upgrade attempt, so the 401 envelope is a
// regular JSON response.
func wsRequest(t *testing.T, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	newTestServer().Router().ServeHTTP(rec, req)
	return rec
}

func TestWebSocketRequiresToken(t *testing.T) {
	rec := wsRequest(t, "/ws", nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("401 body is not the JSON envelope: %v (%s)", err, rec.Body)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

func TestWebSocketRejectsBadToken(t *testing.T) {
	cases := map[string]string{
		"garbage query token":  "/ws?token=not-a-jwt",
		"garbage bearer token": "/ws",
	}
	for name, path := range cases {
		t.Run(name, func(t *testing.T) {
			var headers map[string]string
			if path == "/ws" {
				headers = map[string]string{"Authorization": "Bearer not-a-jwt"}
			}
			rec := wsRequest(t, path, headers)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
			}
			var errBody gen.ErrorResponse
			if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
				t.Fatalf("401 body is not the JSON envelope: %v", err)
			}
			if errBody.Code != "UNAUTHORIZED" {
				t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
			}
		})
	}
}

// TestWebSocketRejectsExpiredToken signs a well-formed token with an exp in
// the past (tokenFor always mints future expiries, so this mints directly
// with the server's secret) and asserts /ws answers 401 before any upgrade.
func TestWebSocketRejectsExpiredToken(t *testing.T) {
	s := newTestServer()
	now := time.Now()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		Role: RoleCustomer,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "expired-ws-user",
			ID:        newRequestID(),
			IssuedAt:  jwt.NewNumericDate(now.Add(-2 * time.Minute)),
			ExpiresAt: jwt.NewNumericDate(now.Add(-time.Minute)),
		},
	}).SignedString(s.cfg.JWTSecret)
	if err != nil {
		t.Fatalf("sign expired token: %v", err)
	}

	rec := wsRequest(t, "/ws", map[string]string{"Authorization": "Bearer " + tok})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("401 body is not the JSON envelope: %v (%s)", err, rec.Body)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}
