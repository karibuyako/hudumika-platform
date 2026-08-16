package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/hudumika/api-backend/internal/gen"
)

// mediaRoute is one media-catalogue HTTP route exercised through the real
// router (migration 00035 handlers in internal/api/media.go).
type mediaRoute struct {
	method string
	path   string
}

var mediaBarcodeRoutes = []mediaRoute{
	{http.MethodGet, "/barcodes/formats"},
	{http.MethodGet, "/barcodes/5901234123457"},
	{http.MethodGet, "/barcodes/5901234123457/history"},
	{http.MethodPost, "/barcodes/batch"},
}

var mediaComboRoutes = []mediaRoute{
	{http.MethodGet, "/combos"},
	{http.MethodPost, "/combos"},
	{http.MethodPatch, "/combos/" + uuid.NewString()},
	{http.MethodDelete, "/combos/" + uuid.NewString()},
}

var mediaMenuRoutes = []mediaRoute{
	{http.MethodGet, "/menus"},
	{http.MethodPost, "/menus"},
	{http.MethodPut, "/menus/" + uuid.NewString()},
	{http.MethodDelete, "/menus/" + uuid.NewString()},
}

var mediaVideoRoutes = []mediaRoute{
	{http.MethodGet, "/videos"},
	{http.MethodPost, "/videos"},
	{http.MethodDelete, "/videos/" + uuid.NewString()},
}

var mediaCategoryRoutes = []mediaRoute{
	{http.MethodGet, "/categories"},
	{http.MethodPost, "/categories"},
	{http.MethodPatch, "/categories/" + uuid.NewString()},
	{http.MethodDelete, "/categories/" + uuid.NewString()},
}

var mediaPrintJobRoutes = []mediaRoute{
	{http.MethodGet, "/print-jobs"},
	{http.MethodPost, "/print-jobs"},
	{http.MethodGet, "/print-jobs/" + uuid.NewString()},
}

// mediaAuthCase is one auth state applied to every route of a group.
type mediaAuthCase struct {
	name     string
	role     string // JWT role claim; "" sends no token at all
	want     int
	wantCode string
}

// mediaAuthCases covers the three auth outcomes the media handlers share: no
// session (401 UNAUTHORIZED from RequireAuth), a non-merchant session (403
// FORBIDDEN from mediaMerchantID) and a merchant session with no database
// wired (500 INTERNAL_ERROR — the merchant identity cannot be resolved).
// Every media handler resolves the merchant identity before anything else,
// so no 422 validation is reachable before that database gate; those rules
// are covered by the integration suite.
var mediaAuthCases = []mediaAuthCase{
	{"no token", "", http.StatusUnauthorized, "UNAUTHORIZED"},
	{"customer session", RoleCustomer, http.StatusForbidden, "FORBIDDEN"},
	{"merchant without database", RoleMerchant, http.StatusInternalServerError, "INTERNAL_ERROR"},
}

// mediaAuthMatrix runs every route of one handler family through every auth
// case.
func mediaAuthMatrix(t *testing.T, routes []mediaRoute) {
	t.Helper()
	s := newTestServer()
	h := s.Router()
	for _, ac := range mediaAuthCases {
		t.Run(ac.name, func(t *testing.T) {
			var token string
			if ac.role != "" {
				token = tokenFor(t, s, "+255889000001", ac.role, false)
			}
			for _, rt := range routes {
				var rec *httptest.ResponseRecorder
				if ac.role == "" {
					rec = doJSON(t, h, rt.method, rt.path, `{}`)
				} else {
					rec = authedDo(t, h, rt.method, rt.path, `{}`, token)
				}
				if rec.Code != ac.want {
					t.Fatalf("%s %s = %d, want %d (%s)", rt.method, rt.path, rec.Code, ac.want, rec.Body)
				}
				var errBody gen.ErrorResponse
				if err := json.NewDecoder(rec.Body).Decode(&errBody); err != nil {
					t.Fatalf("%s %s: decode error body: %v", rt.method, rt.path, err)
				}
				if errBody.Code != ac.wantCode {
					t.Fatalf("%s %s: error code = %q, want %q", rt.method, rt.path, errBody.Code, ac.wantCode)
				}
			}
		})
	}
}

func TestMediaBarcodeAuthMatrix(t *testing.T) { mediaAuthMatrix(t, mediaBarcodeRoutes) }

func TestMediaComboAuthMatrix(t *testing.T) { mediaAuthMatrix(t, mediaComboRoutes) }

func TestMediaMenuAuthMatrix(t *testing.T) { mediaAuthMatrix(t, mediaMenuRoutes) }

func TestMediaVideoAuthMatrix(t *testing.T) { mediaAuthMatrix(t, mediaVideoRoutes) }

func TestMediaCategoryAuthMatrix(t *testing.T) { mediaAuthMatrix(t, mediaCategoryRoutes) }

func TestMediaPrintJobAuthMatrix(t *testing.T) { mediaAuthMatrix(t, mediaPrintJobRoutes) }
