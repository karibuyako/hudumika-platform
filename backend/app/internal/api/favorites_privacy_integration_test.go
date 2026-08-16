//go:build integration

// Favorites, sessions and privacy integration tests against real PostgreSQL
// + Redis.
//
//	cd app && go test -tags integration ./internal/api/ -run 'Favorite|Session|Privacy' -count=1
//
// Every row this suite inserts is owned by a per-run unique phone (+2558…):
// favorites, privacy_requests, notifications, roles, sessions and the users
// row all belong to that user and are deleted at cleanup (cascade) — never a
// truncate.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// uniqueFavPhone builds a per-run unique phone (+2558 prefix as specified for
// this suite) so repeated runs never collide with earlier rows.
func uniqueFavPhone() string {
	return fmt.Sprintf("+2558%09d", time.Now().UnixNano()%1_000_000_000)
}

// waitForPrivacyTables polls to_regclass('public.privacy_requests') and
// to_regclass('public.favorites') every 5s for up to 240s: they arrive with
// migration 00016, which must be applied before this suite runs.
func waitForPrivacyTables(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(240 * time.Second)
	for {
		var reg *string
		if err := pool.QueryRow(context.Background(),
			`SELECT to_regclass('public.privacy_requests')::text || coalesce(':' || to_regclass('public.favorites')::text, ':missing')`).Scan(&reg); err != nil {
			t.Fatalf("privacy poll query: %v", err)
		}
		if reg != nil && len(*reg) > 9 && (*reg)[len(*reg)-8:] != ":missing" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("favorites/privacy_requests tables did not appear within 240s (migration 00016 missing?)")
		}
		time.Sleep(5 * time.Second)
	}
}

// favOTPSession runs a full OTP flow for a unique phone and returns the
// access token, the refresh token and the phone. The durable user row (and
// its cascade: roles, sessions, favorites, privacy_requests, notifications)
// is cleaned up at test end.
func favOTPSession(t *testing.T, h http.Handler, pool *pgxpool.Pool) (access, refresh, phone string, userID uuid.UUID) {
	t.Helper()
	phone = uniqueFavPhone()
	rec := doJSON(t, h, http.MethodPost, "/auth/request-otp", `{"channel":"phone","destination":"`+phone+`"}`)
	var delivery struct {
		RequestId string `json:"requestId"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&delivery)
	if rec.Code != http.StatusOK || delivery.RequestId == "" {
		t.Fatalf("request-otp = %d (%s)", rec.Code, rec.Body)
	}

	rec = doJSON(t, h, http.MethodPost, "/auth/verify-otp",
		`{"requestId":"`+delivery.RequestId+`","code":"123456"}`)
	var session struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&session)
	if rec.Code != http.StatusOK || session.RefreshToken == "" {
		t.Fatalf("verify-otp = %d (%s)", rec.Code, rec.Body)
	}

	if err := pool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE phone = $1`, phone).Scan(&userID); err != nil {
		t.Fatalf("user row missing after OTP flow: %v", err)
	}
	t.Cleanup(func() {
		// Cascade deletes favorites, privacy_requests, notifications, roles
		// and sessions for this user; otp_requests audit rows are keyed by
		// destination and unique per run, matching other suites.
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	return session.AccessToken, session.RefreshToken, phone, userID
}

// TestFavoritesLifecycleIntegration: add → duplicate add (idempotent, still
// one row) → list → remove → add again. The unique (user_id, merchant_id)
// constraint must never produce duplicates.
func TestFavoritesLifecycleIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForPrivacyTables(t, pool)
	h := s.Router()
	access, _, _, _ := favOTPSession(t, h, pool)

	const merchant = "11111111-1111-4111-8111-111111111111"

	rec := authedRequest(t, h, http.MethodPost, "/favorites", access, `{"merchantId":"`+merchant+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("add favorite = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	// Duplicate add is idempotent and still succeeds.
	rec = authedRequest(t, h, http.MethodPost, "/favorites", access, `{"merchantId":"`+merchant+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("duplicate add favorite = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	rec = authedRequest(t, h, http.MethodGet, "/favorites", access, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list favorites = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var listed []struct {
		Id string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&listed); err != nil {
		t.Fatalf("decode favorites: %v", err)
	}
	if len(listed) != 1 || listed[0].Id != merchant {
		t.Fatalf("favorites = %+v, want exactly [%s]", listed, merchant)
	}

	rec = authedRequest(t, h, http.MethodDelete, "/favorites/"+merchant, access, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("remove favorite = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	rec = authedRequest(t, h, http.MethodGet, "/favorites", access, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list after remove = %d (%s)", rec.Code, rec.Body)
	}
	if err := json.NewDecoder(rec.Body).Decode(&listed); err != nil {
		t.Fatalf("decode favorites: %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("favorites after remove = %+v, want []", listed)
	}

	rec = authedRequest(t, h, http.MethodPost, "/favorites", access, `{"merchantId":"`+merchant+`"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("re-add favorite = %d, want 204 (%s)", rec.Code, rec.Body)
	}
	rec = authedRequest(t, h, http.MethodGet, "/favorites", access, "")
	if err := json.NewDecoder(rec.Body).Decode(&listed); err != nil {
		t.Fatalf("decode favorites: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("favorites after re-add = %+v, want 1 entry", listed)
	}
}

// TestSessionsListIntegration: after a full OTP flow the durable session row
// appears in GET /sessions for the user.
func TestSessionsListIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForPrivacyTables(t, pool)
	h := s.Router()
	access, _, _, userID := favOTPSession(t, h, pool)

	var live int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`,
		userID).Scan(&live); err != nil {
		t.Fatalf("session count query: %v", err)
	}
	if live != 1 {
		t.Fatalf("live session rows = %d, want 1", live)
	}

	rec := authedRequest(t, h, http.MethodGet, "/sessions", access, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("list sessions = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var sessions []struct {
		Id           string `json:"id"`
		DeviceInfo   string `json:"deviceInfo"`
		LastActiveAt string `json:"lastActiveAt"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&sessions); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("listed sessions = %d, want 1", len(sessions))
	}
	if _, err := uuid.Parse(sessions[0].Id); err != nil {
		t.Fatalf("session id %q is not a uuid: %v", sessions[0].Id, err)
	}
	if sessions[0].LastActiveAt == "" {
		t.Fatal("session lastActiveAt missing")
	}
}

// TestSessionsRevokeIntegration: revoking a listed session by its id revokes
// the Redis record and the durable row: refresh with that token fails with
// 401 and revoked_at is set.
func TestSessionsRevokeIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForPrivacyTables(t, pool)
	h := s.Router()
	access, refresh, _, userID := favOTPSession(t, h, pool)

	rec := authedRequest(t, h, http.MethodGet, "/sessions", access, "")
	var sessions []struct {
		Id string `json:"id"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&sessions); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("listed sessions = %d, want 1", len(sessions))
	}

	rec = authedRequest(t, h, http.MethodPost, "/sessions/"+sessions[0].Id+"/revoke", access, "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("revoke session = %d, want 204 (%s)", rec.Code, rec.Body)
	}

	// The revoked refresh token must no longer refresh (Redis is
	// authoritative on the hot path).
	rec = doJSON(t, h, http.MethodPost, "/auth/refresh", `{"refreshToken":"`+refresh+`"}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("refresh after revoke = %d, want 401 (%s)", rec.Code, rec.Body)
	}

	var revokedAt *time.Time
	if err := pool.QueryRow(context.Background(),
		`SELECT revoked_at FROM sessions WHERE user_id = $1`, userID).Scan(&revokedAt); err != nil {
		t.Fatalf("revoked_at query: %v", err)
	}
	if revokedAt == nil {
		t.Fatal("sessions row revoked_at not set after API revoke")
	}
}

// TestPrivacyExportIntegration: the export 202 carries the assembled data —
// the caller's profile, notifications and favorites — and a second call while
// the first is still open conflicts with PRIVACY_EXPORT_IN_PROGRESS.
func TestPrivacyExportIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForPrivacyTables(t, pool)
	h := s.Router()
	access, _, phone, userID := favOTPSession(t, h, pool)

	const merchant = "22222222-2222-4222-8222-222222222222"
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO favorites (user_id, merchant_id) VALUES ($1, $2)`, userID, merchant); err != nil {
		t.Fatalf("seed favorite: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO notifications (user_id, type, title, body) VALUES ($1, 'test', 'Export title', 'Export body')`,
		userID); err != nil {
		t.Fatalf("seed notification: %v", err)
	}

	rec := authedRequest(t, h, http.MethodPost, "/privacy/export", access, "")
	if rec.Code != http.StatusAccepted {
		t.Fatalf("privacy export = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var resp struct {
		JobId  string `json:"jobId"`
		Status string `json:"status"`
		Data   struct {
			User struct {
				Phone string `json:"phone"`
			} `json:"user"`
			Notifications []struct {
				Title string `json:"title"`
			} `json:"notifications"`
			Favorites []struct {
				MerchantID string `json:"merchantId"`
			} `json:"favorites"`
		} `json:"data"`
		ExpiresAt string `json:"expiresAt"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode export: %v", err)
	}
	if _, err := uuid.Parse(resp.JobId); err != nil {
		t.Fatalf("jobId %q is not a uuid: %v", resp.JobId, err)
	}
	if resp.Status != "queued" {
		t.Fatalf("status = %q, want queued", resp.Status)
	}
	if resp.Data.User.Phone != phone {
		t.Fatalf("export user phone = %q, want %q", resp.Data.User.Phone, phone)
	}
	if len(resp.Data.Notifications) != 1 || resp.Data.Notifications[0].Title != "Export title" {
		t.Fatalf("export notifications = %+v, want the seeded row", resp.Data.Notifications)
	}
	if len(resp.Data.Favorites) != 1 || resp.Data.Favorites[0].MerchantID != merchant {
		t.Fatalf("export favorites = %+v, want the seeded merchant", resp.Data.Favorites)
	}
	if resp.ExpiresAt == "" {
		t.Fatal("export expiresAt missing")
	}

	// A second export while the first request is still open conflicts.
	rec2 := authedRequest(t, h, http.MethodPost, "/privacy/export", access, "")
	if rec2.Code != http.StatusConflict {
		t.Fatalf("second export = %d, want 409 (%s)", rec2.Code, rec2.Body)
	}
}

// TestPrivacyDeleteIntegration: a valid confirmation creates the durable
// pending deletion request (202); a missing confirmation is rejected with
// 422 and a second call conflicts with ACCOUNT_DELETION_PENDING.
func TestPrivacyDeleteIntegration(t *testing.T) {
	s, pool := newPersistentServer(t)
	waitForPrivacyTables(t, pool)
	h := s.Router()
	access, _, _, userID := favOTPSession(t, h, pool)

	rec := authedRequest(t, h, http.MethodPost, "/privacy/delete", access,
		`{"reason":"no confirmation supplied"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("delete without confirmation = %d, want 422 (%s)", rec.Code, rec.Body)
	}

	rec = authedRequest(t, h, http.MethodPost, "/privacy/delete", access,
		`{"confirmation":"DELETE","reason":"integration test"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("privacy delete = %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var resp struct {
		RequestId     string `json:"requestId"`
		EstimatedDays int    `json:"estimatedDays"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode delete: %v", err)
	}
	if _, err := uuid.Parse(resp.RequestId); err != nil {
		t.Fatalf("requestId %q is not a uuid: %v", resp.RequestId, err)
	}
	if resp.EstimatedDays <= 0 {
		t.Fatalf("estimatedDays = %d, want positive", resp.EstimatedDays)
	}

	var kind, status string
	if err := pool.QueryRow(context.Background(),
		`SELECT kind, status FROM privacy_requests WHERE user_id = $1 AND kind = 'deletion'`,
		userID).Scan(&kind, &status); err != nil {
		t.Fatalf("privacy_requests row missing: %v", err)
	}
	if status != "pending" {
		t.Fatalf("deletion status = %q, want pending", status)
	}

	rec = authedRequest(t, h, http.MethodPost, "/privacy/delete", access, `{"confirmation":"DELETE"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second delete = %d, want 409 (%s)", rec.Code, rec.Body)
	}
}
