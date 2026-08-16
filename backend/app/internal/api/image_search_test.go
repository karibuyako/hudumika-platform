package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestImageSearchRequiresAuth: /search/image is not in isPublicPath, so the
// router gate (RequireAuth) rejects an unauthenticated request with 401
// before the handler runs.
func TestImageSearchRequiresAuth(t *testing.T) {
	s := newTestServer()

	req := newAuthedRequest(http.MethodPost, "/search/image", `{"imageUrl":"https://example.com/pizza.jpg"}`, "")
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestImageSearchMissingImageUrl: an empty or whitespace imageUrl is a 422
// before any other work (the body itself must be valid JSON).
func TestImageSearchMissingImageUrl(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, body := range []string{`{}`, `{"imageUrl":""}`, `{"imageUrl":"   "}`} {
		rec := authedPOSTJSON(t, s.Router(), "/search/image", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("body %s error code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}
}

// TestImageSearchInvalidImageUrl: a non-uri or non-http(s) imageUrl is a 422.
func TestImageSearchInvalidImageUrl(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, body := range []string{
		`{"imageUrl":"not-a-url"}`,
		`{"imageUrl":"ftp://example.com/pizza.jpg"}`,
		`{"imageUrl":"http://"}`,
		`{"imageUrl":"https://"}`,
	} {
		rec := authedPOSTJSON(t, s.Router(), "/search/image", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s status = %d, want 422 (%s)", body, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "VALIDATION_FAILED" {
			t.Fatalf("body %s error code = %q, want VALIDATION_FAILED", body, errBody.Code)
		}
	}
}

// TestImageSearchPlaceholder: a valid imageUrl answers 200 with the contract
// SearchResults shape: query echoes the imageUrl and results is the empty
// array (never null). The unit-test server has no database wired (s.db nil),
// which the stateless placeholder must tolerate.
func TestImageSearchPlaceholder(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	rec := authedPOSTJSON(t, s.Router(), "/search/image",
		`{"imageUrl":"https://cdn.example.com/images/pizza-margherita.jpg?w=800"}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var out gen.SearchResults
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if out.Query != "https://cdn.example.com/images/pizza-margherita.jpg?w=800" {
		t.Fatalf("query = %q, want the echoed imageUrl", out.Query)
	}
	if len(out.Results) != 0 {
		t.Fatalf("results = %d rows, want the empty placeholder array", len(out.Results))
	}
	if out.Total != nil {
		t.Fatalf("total = %d, want omitted", *out.Total)
	}
}
