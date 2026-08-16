package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestMaskPIISensitiveFields(t *testing.T) {
	s := newTestServer()
	r := chi.NewRouter()
	r.Get("/probe", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"accountNumber":  "1234567890",
			"account_number": "0987654321",
			"cardNumber":     "4111111111111111",
			"cvv":            "123",
			"nationalId":     "NID-12345",
			"documentUrl":    "https://cdn.example.com/id.pdf",
			"dob":            "1990-01-01",
			"name":           "X",
			"phone":          "+255712345678",
			"amountTZS":      2500,
			"bankAccount":    "999888777",
		})
	})
	rec := httptest.NewRecorder()
	s.MaskPII(r).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/probe", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, k := range []string{"accountNumber", "account_number", "cardNumber", "cvv", "nationalId", "documentUrl", "dob"} {
		if body[k] != maskedValue {
			t.Fatalf("%s = %q, want masked", k, body[k])
		}
	}
	if body["name"] != "X" {
		t.Fatalf("name = %q, want untouched", body["name"])
	}
	if body["phone"] != "+255712345678" {
		t.Fatalf("phone = %q, want untouched", body["phone"])
	}
	if body["amountTZS"] != float64(2500) {
		t.Fatalf("amountTZS = %v, want untouched", body["amountTZS"])
	}
	if body["bankAccount"] != "999888777" {
		t.Fatalf("bankAccount = %v, want untouched", body["bankAccount"])
	}
}

func TestMaskPIIKeepsErrorEnvelope(t *testing.T) {
	s := newTestServer()
	r := chi.NewRouter()
	r.Get("/boom", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "nope")
	})
	rec := httptest.NewRecorder()
	s.MaskPII(r).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	var errBody struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if errBody.Code != "VALIDATION_FAILED" || errBody.Message != "nope" {
		t.Fatalf("envelope = %+v", errBody)
	}
}
