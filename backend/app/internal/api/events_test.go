package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/hudumika/api-backend/internal/gen"
)

// eventsTestToken mints an access token for the events surfaces directly
// (tests mint role variants through mintAccessToken per AUTH.md). /events and
// /monitoring/errors match no routePolicy prefix, so any authenticated role
// passes the policy check.
func eventsTestToken(t *testing.T, s *Server) string {
	t.Helper()
	now := time.Now()
	tok, err := s.mintAccessToken(Claims{
		Role: RoleCustomer,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "events-test-user",
			ID:        newRequestID(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
		},
	})
	if err != nil {
		t.Fatalf("mint access token: %v", err)
	}
	return tok
}

// eventsAuthedRequest runs the request through the server router with a
// bearer token attached.
func eventsAuthedRequest(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	token := eventsTestToken(t, s)
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	return rec
}

func TestServerEventsRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("events without token = %d, want 401", rec.Code)
	}
}

func TestServerEventsMissingAfterRejected(t *testing.T) {
	s := newTestServer()
	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events", "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("events without after = %d, want 400 (%s)", rec.Code, rec.Body)
	}
}

func TestServerEventsNegativeAfterRejected(t *testing.T) {
	s := newTestServer()
	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=-1", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("events with after=-1 = %d, want 422", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

func TestServerEventsNoRedisReturns501(t *testing.T) {
	s := newTestServer()
	rec := eventsAuthedRequest(t, s, http.MethodGet, "/events?after=0", "")
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("events without redis = %d, want 501", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "NOT_IMPLEMENTED" {
		t.Fatalf("error code = %q, want NOT_IMPLEMENTED", errBody.Code)
	}
}

func TestClientErrorReportRequiresAuth(t *testing.T) {
	// Contract marks /monitoring/errors unauthenticated and isPublicPath
	// names it — the report is accepted without a token (204).
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/monitoring/errors", `{"message":"boom","stack":"at x"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("error report without token = %d, want 204 (public per contract)", rec.Code)
	}
}

func TestClientErrorReportEmptyMessageRejected(t *testing.T) {
	s := newTestServer()
	rec := eventsAuthedRequest(t, s, http.MethodPost, "/monitoring/errors", `{"message":"","stack":"at x"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("error report with empty message = %d, want 422", rec.Code)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", errBody.Code)
	}
}

func TestClientErrorReportAccepted(t *testing.T) {
	s := newTestServer()
	rec := eventsAuthedRequest(t, s, http.MethodPost, "/monitoring/errors",
		`{"message":"boom","stack":"at x","context":{"url":"/checkout"}}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("error report = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("error report body = %q, want empty", rec.Body.String())
	}
}
