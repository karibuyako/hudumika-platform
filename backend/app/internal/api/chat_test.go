package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hudumika/api-backend/internal/gen"
)

const chatTestConversationID = "11111111-1111-4111-8111-111111111111"

// chatAuthedGET sends an authenticated GET.
func chatAuthedGET(t *testing.T, h http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	return authedDo(t, h, http.MethodGet, path, "", token)
}

// TestChatConversationsRequireToken: every /conversations route without a
// bearer token is rejected with the UNAUTHORIZED envelope.
func TestChatConversationsRequireToken(t *testing.T) {
	h := newTestServer().Router()

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"list", http.MethodGet, "/conversations", ""},
		{"create", http.MethodPost, "/conversations",
			`{"merchantId":"22222222-2222-4222-8222-222222222222","subject":"Order help","initialMessage":"hi"}`},
		{"unread", http.MethodGet, "/conversations/unread-count", ""},
		{"get", http.MethodGet, "/conversations/" + chatTestConversationID, ""},
		{"messages", http.MethodGet, "/conversations/" + chatTestConversationID + "/messages", ""},
		{"send", http.MethodPost, "/conversations/" + chatTestConversationID + "/messages", `{"body":"hi"}`},
		{"read", http.MethodPost, "/conversations/" + chatTestConversationID + "/read", ""},
		{"archive", http.MethodPost, "/conversations/" + chatTestConversationID + "/archive", ""},
		{"block", http.MethodPost, "/conversations/" + chatTestConversationID + "/block", `{"reason":"spam"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, h, tc.method, tc.path, tc.body)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			assertErrorBodyCode(t, rec, "UNAUTHORIZED")
		})
	}
}

// TestChatWithoutDBReturns500: with a valid token but no database wired, the
// conversation surface answers the 500 envelope. The DB gate sits between
// the token check and the users-row lookup in chatCaller, so the ordering is
// observable: claims resolve from the JWT alone, the missing database fails
// the request before any identity query — chat state is meaningless without
// durable identity, so unlike users.go's currentUser there is no 404
// fallback for a missing database.
func TestChatWithoutDBReturns500(t *testing.T) {
	s := newTestServer()
	phone := "+255700000001"
	ses, err := s.issueSession(context.Background(), phone, time.Now())
	if err != nil {
		t.Fatalf("issue session: %v", err)
	}
	h := s.Router()

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"list", http.MethodGet, "/conversations", ""},
		{"create", http.MethodPost, "/conversations",
			`{"merchantId":"22222222-2222-4222-8222-222222222222","subject":"Order help","initialMessage":"hi"}`},
		{"unread", http.MethodGet, "/conversations/unread-count", ""},
		{"get", http.MethodGet, "/conversations/" + chatTestConversationID, ""},
		{"messages", http.MethodGet, "/conversations/" + chatTestConversationID + "/messages", ""},
		{"send", http.MethodPost, "/conversations/" + chatTestConversationID + "/messages", `{"body":"hi"}`},
		{"read", http.MethodPost, "/conversations/" + chatTestConversationID + "/read", ""},
		{"archive", http.MethodPost, "/conversations/" + chatTestConversationID + "/archive", ""},
		{"block", http.MethodPost, "/conversations/" + chatTestConversationID + "/block", `{"reason":"spam"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := authedDo(t, h, tc.method, tc.path, tc.body, ses.AccessToken)
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
		})
	}
}
