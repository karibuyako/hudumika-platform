//go:build integration

// Admin review moderation against real PostgreSQL + Redis
// (docker compose). Run via `make test-integration` after `make migrate`,
// or DATABASE_URL=postgres://hudumika:hudumika@localhost:5432/hudumika
// REDIS_URL=redis://localhost:6379/0 go test -tags integration ./internal/api/ -run Moderate -count=1
// Every test seeds only its own rows (unique +2559* phone, unique target id)
// and deletes exactly those rows in cleanup; the shared reviews/users tables
// are never truncated (the reviews package suite truncates them itself).
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hudumika/api-backend/internal/gen"
)

// seedModerationReview inserts a review in the given state for a unique
// target and registers cleanup that deletes exactly this review and its
// author's rows.
func seedModerationReview(t *testing.T, pool *pgxpool.Pool, state string) (reviewID uuid.UUID, targetID uuid.UUID) {
	t.Helper()
	base := uniqueAdminPhone(t, "mod")
	author := seedAdminUser(t, pool, base, "Review Author "+base, "customer", time.Now())

	targetID = uuid.New()
	body := "seeded moderation review " + base
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO reviews (target_type, target_id, author_user_id, rating, body, state)
		 VALUES ('merchant', $1, $2, 5, $3, $4) RETURNING id`,
		targetID, author, body, state).Scan(&reviewID); err != nil {
		t.Fatalf("seed review: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM reviews WHERE id = $1`, reviewID)
	})
	return reviewID, targetID
}

func reviewState(t *testing.T, pool *pgxpool.Pool, reviewID uuid.UUID) string {
	t.Helper()
	var state string
	if err := pool.QueryRow(context.Background(),
		`SELECT state FROM reviews WHERE id = $1`, reviewID).Scan(&state); err != nil {
		t.Fatalf("select state: %v", err)
	}
	return state
}

func moderate(t *testing.T, s *Server, token, reviewID, action string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"reviewId":%q,"action":%q}`, reviewID, action)
	return moderatePOST(t, s.Router(), body, token)
}

// TestAdminModeratePublishLifecycle: a pending review is published by the
// moderation endpoint and the state change is persisted; publishing again is
// an idempotent 200.
func TestAdminModeratePublishLifecycle(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	reviewID, _ := seedModerationReview(t, pool, "pending")
	if got := reviewState(t, pool, reviewID); got != "pending" {
		t.Fatalf("seeded state = %q, want pending", got)
	}

	rec := moderate(t, s, token, reviewID.String(), "publish")
	if rec.Code != http.StatusOK {
		t.Fatalf("publish status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	var published gen.Review
	if err := json.NewDecoder(rec.Body).Decode(&published); err != nil {
		t.Fatalf("decode publish response: %v", err)
	}
	if published.State != gen.ReviewStatePublished {
		t.Fatalf("response state = %q, want published", published.State)
	}
	if got := reviewState(t, pool, reviewID); got != "published" {
		t.Fatalf("persisted state = %q, want published", got)
	}

	// Publishing an already published review is an idempotent 200 no-op.
	rec = moderate(t, s, token, reviewID.String(), "publish")
	if rec.Code != http.StatusOK {
		t.Fatalf("re-publish status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := reviewState(t, pool, reviewID); got != "published" {
		t.Fatalf("state after re-publish = %q, want published", got)
	}
}

// TestAdminModerateHideAndDelete: hide moves a published review to hidden and
// delete moves it on to deleted.
func TestAdminModerateHideAndDelete(t *testing.T) {
	s, pool := newPersistentServer(t)
	token := staffAdminToken(t, s)

	reviewID, _ := seedModerationReview(t, pool, "published")

	rec := moderate(t, s, token, reviewID.String(), "hide")
	if rec.Code != http.StatusOK {
		t.Fatalf("hide status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := reviewState(t, pool, reviewID); got != "hidden" {
		t.Fatalf("state after hide = %q, want hidden", got)
	}

	rec = moderate(t, s, token, reviewID.String(), "delete")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d, want 200 (%s)", rec.Code, rec.Body)
	}
	if got := reviewState(t, pool, reviewID); got != "deleted" {
		t.Fatalf("state after delete = %q, want deleted", got)
	}
}

// TestAdminModerateMissingReview: moderating a review that does not exist
// answers 404 REVIEW_NOT_FOUND.
func TestAdminModerateMissingReview(t *testing.T) {
	s, _ := newPersistentServer(t)
	token := staffAdminToken(t, s)

	rec := moderate(t, s, token, uuid.New().String(), "publish")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "REVIEW_NOT_FOUND" {
		t.Fatalf("error code = %q, want REVIEW_NOT_FOUND", errBody.Code)
	}
}

// TestAdminModerateCustomerToken: a customer session is denied with 403
// FORBIDDEN even against a real database.
func TestAdminModerateCustomerToken(t *testing.T) {
	s, _ := newPersistentServer(t)
	token := tokenFor(t, s, "+255700000009", RoleCustomer, false)

	rec := moderate(t, s, token, uuid.New().String(), "publish")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body)
	}
	var errBody gen.ErrorResponse
	_ = json.NewDecoder(rec.Body).Decode(&errBody)
	if errBody.Code != "FORBIDDEN" {
		t.Fatalf("error code = %q, want FORBIDDEN", errBody.Code)
	}
}
