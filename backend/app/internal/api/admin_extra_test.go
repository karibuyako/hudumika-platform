package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hudumika/api-backend/internal/gen"
)

// authedExtraJSON sends an authenticated JSON request (method + body), the
// admin-extra sibling of authedGET. Defined here rather than reusing the
// staffops helper so this file never depends on another agent's test file.
func authedExtraJSON(t *testing.T, h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// adminExtraPaths are the admin-extra GET surfaces; every one must reject
// unauthenticated requests with 401 before the handler runs.
var adminExtraGETPaths = []string{
	"/admin/banners",
	"/admin/features",
	"/admin/data-exports",
	"/admin/group-buys",
	"/admin/conversations",
	"/admin/integrations",
}

// TestAdminExtraRequiresAuth: every admin-extra route is rejected by
// RequireAuth (401 UNAUTHORIZED) without a bearer token.
func TestAdminExtraRequiresAuth(t *testing.T) {
	s := newTestServer()

	paths := append(append([]string{}, adminExtraGETPaths...),
		"/admin/help/articles", "/admin/notifications/send", "/admin/search?q=x")
	for _, path := range paths {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		s.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "UNAUTHORIZED" {
			t.Fatalf("%s error code = %q, want UNAUTHORIZED", path, errBody.Code)
		}
	}
}

// TestAdminExtraRejectsCustomerToken: a customer session is denied on every
// admin-extra route by the route policy (403 FORBIDDEN) before handler code
// runs.
func TestAdminExtraRejectsCustomerToken(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "+255700000001", RoleCustomer, false)

	for _, path := range adminExtraGETPaths {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s status = %d, want 403 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "FORBIDDEN" {
			t.Fatalf("%s error code = %q, want FORBIDDEN", path, errBody.Code)
		}
	}
}

// TestAdminExtraStaffNoDatabase: staff with an MFA-verified session reach
// the handlers, which fail with the INTERNAL_ERROR envelope when no
// database is wired (dev, unit-test server).
func TestAdminExtraStaffNoDatabase(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-extra-1", RoleAdmin, true)

	for _, path := range adminExtraGETPaths {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s status = %d, want 500 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s error code = %q, want INTERNAL_ERROR", path, errBody.Code)
		}
	}

	mutations := []struct {
		method, path, body string
	}{
		{http.MethodPost, "/admin/banners", `{"title":"Unit","placement":"home_top"}`},
		{http.MethodPatch, "/admin/banners/00000000-0000-0000-0000-000000000001", `{"title":"Unit"}`},
		{http.MethodDelete, "/admin/banners/00000000-0000-0000-0000-000000000001", ""},
		{http.MethodPatch, "/admin/features", `{"key":"unit.feature","enabled":true}`},
		{http.MethodPost, "/admin/help/articles", `{"title":"Unit","category":"faq","body":"x"}`},
		{http.MethodPut, "/admin/help/articles", `{"id":"00000000-0000-0000-0000-000000000001","title":"Unit"}`},
		{http.MethodPost, "/admin/notifications/send", `{"title":"Unit","body":"hello","audience":{"roles":["customer"]}}`},
		{http.MethodPost, "/admin/group-buys/00000000-0000-0000-0000-000000000001/decision", `{"decision":"approved"}`},
	}
	for _, m := range mutations {
		rec := authedExtraJSON(t, s.Router(), m.method, m.path, m.body, token)
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("%s %s status = %d, want 500 (%s)", m.method, m.path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "INTERNAL_ERROR" {
			t.Fatalf("%s %s error code = %q, want INTERNAL_ERROR", m.method, m.path, errBody.Code)
		}
	}
}

// TestAdminGlobalSearchEmptyQuery: an empty q answers 422
// ADMIN_SEARCH_INVALID before the database gate — no database is wired in
// this unit server, and the validation still wins. (A wholly absent q is
// rejected by the generated required-param validation with 400 before the
// handler runs.)
func TestAdminGlobalSearchEmptyQuery(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-extra-2", RoleAdmin, true)

	for _, path := range []string{"/admin/search?q=", "/admin/search?q=%20"} {
		rec := authedGET(t, s.Router(), path, token)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("%s status = %d, want 422 (%s)", path, rec.Code, rec.Body)
		}
		var errBody gen.ErrorResponse
		_ = json.NewDecoder(rec.Body).Decode(&errBody)
		if errBody.Code != "ADMIN_SEARCH_INVALID" {
			t.Fatalf("%s error code = %q, want ADMIN_SEARCH_INVALID", path, errBody.Code)
		}
	}

	// The missing-parameter case is enforced by the generated wrapper before
	// the handler: 422 VALIDATION_FAILED via ErrorHandlerFunc.
	rec := authedGET(t, s.Router(), "/admin/search", token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing q status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
}

// TestAdminGlobalSearchOverlongQuery: a q beyond the contract's 200-char
// bound answers 422 ADMIN_SEARCH_INVALID without a database.
func TestAdminGlobalSearchOverlongQuery(t *testing.T) {
	s := newTestServer()
	token := tokenFor(t, s, "u-admin-extra-3", RoleAdmin, true)

	q := make([]byte, 201)
	for i := range q {
		q[i] = 'a'
	}
	rec := authedGET(t, s.Router(), "/admin/search?q="+string(q), token)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "ADMIN_SEARCH_INVALID" {
		t.Fatalf("error code = %q, want ADMIN_SEARCH_INVALID", errBody.Code)
	}
}
