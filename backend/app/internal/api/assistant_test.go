package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// --- /products/assistant/* unit tests (no database) ---

func TestAssistantDescribeNoToken(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/products/assistant/describe", `{"keywords":["pilau"]}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

func TestAssistantDescribeDeterministic(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000011", RoleMerchant, false)
	h := s.Router()

	call := func() string {
		rec := assistantAuthedJSON(h, http.MethodPost, "/products/assistant/describe",
			`{"keywords":["pilau","beef","spicy"]}`, token)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
		}
		var body struct {
			Description string `json:"description"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body.Description
	}
	// Identical input yields identical output (rule-based, no model).
	first := call()
	second := call()
	if first != second {
		t.Fatalf("descriptions differ across identical calls: %q vs %q", first, second)
	}
	if first == "" {
		t.Fatal("empty description")
	}
	if len(first) > 2000 {
		t.Fatalf("description exceeds contract default maxLength: %d", len(first))
	}
}

func TestAssistantDescribeMaxLengthRespected(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000011", RoleMerchant, false)
	rec := assistantAuthedJSON(s.Router(), http.MethodPost, "/products/assistant/describe",
		`{"keywords":["pilau","beef","spicy","rice"],"maxLength":40}`, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var body struct {
		Description string `json:"description"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&body)
	if len(body.Description) > 40 {
		t.Fatalf("description length = %d, want <= 40", len(body.Description))
	}
}

func TestAssistantDescribeEmptyKeywordsRejected(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000011", RoleMerchant, false)
	for _, body := range []string{`{"keywords":[]}`, `{"keywords":["  ",""]}`, `{"keywords":["x"],"maxLength":5}`} {
		rec := assistantAuthedJSON(s.Router(), http.MethodPost, "/products/assistant/describe", body, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("body %s: status = %d, want 422", body, rec.Code)
		}
	}
}

// assistantAuthedJSON sends an authed request with an optional JSON body
// (local helper; the shared authedPOSTJSON lives in dispatch_test.go).
func assistantAuthedJSON(h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAssistantSuggestionsRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := authedGET(t, h, "/products/assistant/suggestions", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAssistantSuggestionsNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000012", RoleMerchant, false)
	rec := authedGET(t, s.Router(), "/products/assistant/suggestions", token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

func TestAssistantSuggestionsRejectsCustomer(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000013", RoleCustomer, false)
	rec := authedGET(t, s.Router(), "/products/assistant/suggestions", token)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
}

func TestAssistantApplyRequiresAuth(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/products/assistant/apply", `{}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestAssistantApplyNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000014", RoleMerchant, false)
	rec := authedPOSTJSON(t, s.Router(), "/products/assistant/apply",
		`{"itemId":"00000000-0000-4000-8000-000000000001","type":"price","value":"5000"}`, token)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// authedPOSTJSON is shared from dispatch_test.go.
