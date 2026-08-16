package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// simulateUnitPost sends a POST to the router with the given internal key.
func simulateUnitPost(t *testing.T, h http.Handler, path, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("x-internal-key", key)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// simulateErrCode decodes the error envelope of a recorder.
func simulateErrCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var errBody gen.ErrorResponse
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode error body: %v (%s)", err, rec.Body)
	}
	return errBody.Code
}

// TestSimulateGateNotConfigured: with SIMULATOR_KEY unset the whole
// /internal surface answers 403 FORBIDDEN before any handler runs, no matter
// which key the caller presents.
func TestSimulateGateNotConfigured(t *testing.T) {
	t.Setenv("SIMULATOR_KEY", "")
	h := newTestServer().Router()

	rec := simulateUnitPost(t, h, "/internal/simulate/order", "anything", `{"destination":"+255700000001"}`)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	if code := simulateErrCode(t, rec); code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", code)
	}
}

// TestSimulateGateWrongKey: with SIMULATOR_KEY set, a wrong (or missing)
// x-internal-key header is rejected in constant time with 403 FORBIDDEN.
func TestSimulateGateWrongKey(t *testing.T) {
	t.Setenv("SIMULATOR_KEY", "test-simulator-key")
	h := newTestServer().Router()

	for _, key := range []string{"", "wrong-key", "test-simulator-"} {
		rec := simulateUnitPost(t, h, "/internal/simulate/order", key, `{"destination":"+255700000002"}`)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("key %q status = %d, want 403 (%s)", key, rec.Code, rec.Body)
		}
		if code := simulateErrCode(t, rec); code != "FORBIDDEN" {
			t.Fatalf("key %q error code = %q, want FORBIDDEN", key, code)
		}
	}
}

// TestSimulateGateValidKey: the right key passes the gate; the handler then
// answers 400 VALIDATION_FAILED for an empty body (no database needed) —
// reaching the handler proves the gate let the request through.
func TestSimulateGateValidKey(t *testing.T) {
	t.Setenv("SIMULATOR_KEY", "test-simulator-key")
	h := newTestServer().Router()

	rec := simulateUnitPost(t, h, "/internal/simulate/order", "test-simulator-key", `{}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body)
	}
	if code := simulateErrCode(t, rec); code != "VALIDATION_FAILED" {
		t.Fatalf("error code = %q, want VALIDATION_FAILED", code)
	}
}

// TestSimulateBadJSONBody: a malformed body is 400 VALIDATION_FAILED on
// every simulator flow, behind the gate.
func TestSimulateBadJSONBody(t *testing.T) {
	t.Setenv("SIMULATOR_KEY", "test-simulator-key")
	h := newTestServer().Router()

	for _, path := range []string{"/internal/simulate/order", "/internal/simulate/chat", "/internal/simulate/rush"} {
		rec := simulateUnitPost(t, h, path, "test-simulator-key", `{not json`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400 (%s)", path, rec.Code, rec.Body)
		}
		if code := simulateErrCode(t, rec); code != "VALIDATION_FAILED" {
			t.Fatalf("%s error code = %q, want VALIDATION_FAILED", path, code)
		}
	}
}
