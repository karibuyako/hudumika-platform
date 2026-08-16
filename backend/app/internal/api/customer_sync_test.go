package api

// CUSTOMER OFFLINE SYNC + API DOCS unit tests (no database): POST /sync/batch
// sits behind RequireAuth, so a missing token is 401 UNAUTHORIZED before any
// handler code runs, and with a customer token but no database wired the
// handler answers the 500 INTERNAL_ERROR envelope (the orderActor database
// gate runs before any state lookup). The /docs endpoints are public: they
// answer 200 without any token, and /docs/openapi.yaml serves the embedded
// spec bytes (JSON) with Content-Type application/yaml.
import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// TestSyncCustomerRequiresToken: POST /sync/batch without a bearer token is
// rejected by RequireAuth with the 401 UNAUTHORIZED envelope.
func TestSyncCustomerRequiresToken(t *testing.T) {
	h := newTestServer().Router()
	rec := doJSON(t, h, http.MethodPost, "/sync/batch",
		`{"events":[{"seq":1,"type":"order.status","payload":{"orderId":"00000000-0000-0000-0000-000000000000","status":"cancelled","expectedVersion":1}}]}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "UNAUTHORIZED" {
		t.Fatalf("error code = %q, want UNAUTHORIZED", errBody.Code)
	}
}

// TestSyncCustomerNoDatabase: with a customer session but no database wired,
// SyncCustomerBatch answers the 500 INTERNAL_ERROR envelope from the
// orderActor database gate (never a panic on the state lookup).
func TestSyncCustomerNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)
	rec := authedRequest(t, s.Router(), http.MethodPost, "/sync/batch", token,
		`{"events":[{"seq":1,"type":"order.status","payload":{"orderId":"00000000-0000-0000-0000-000000000000","status":"cancelled","expectedVersion":1}}]}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody.Code != "INTERNAL_ERROR" {
		t.Fatalf("error code = %q, want INTERNAL_ERROR", errBody.Code)
	}
}

// TestDocsPublic: the docs surface is public — GET /docs and
// GET /docs/openapi.yaml answer 200 without any token. The spec endpoint
// serves the embedded spec with Content-Type application/yaml; the body is
// the spec JSON (starts with '{'), and the HTML index links to the spec.
func TestDocsPublic(t *testing.T) {
	h := newTestServer().Router()

	rec := doJSON(t, h, http.MethodGet, "/docs/openapi.yaml", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("spec status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/yaml" {
		t.Fatalf("spec content-type = %q, want application/yaml", ct)
	}
	body := rec.Body.String()
	if !strings.HasPrefix(strings.TrimSpace(body), "{") {
		t.Fatalf("spec body does not start with '{' (the spec is embedded as JSON): %q", body[:min(len(body), 40)])
	}

	rec = doJSON(t, h, http.MethodGet, "/docs", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("docs index status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	page := rec.Body.String()
	for _, want := range []string{"<title>Hudumika API</title>", "/docs/openapi.yaml", "<table>"} {
		if !strings.Contains(page, want) {
			t.Fatalf("docs index missing %q", want)
		}
	}
}
